if (typeof(process.env.ROLLBAR_TOKEN) !== "undefined") {
    var Rollbar = require('rollbar');
    new Rollbar({
        accessToken: process.env.ROLLBAR_TOKEN,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
}

const exec = require("child_process");
const crypto = require("crypto");
const version = require('./package.json').version;
const io = require('socket.io-client');
const fs = require("fs-extra");
const chmodr = require('chmodr');

// The worker owns the program path (SEC-EXEC-02, D-04). An argv job carries
// arguments only, so the API can never name what runs on this root +
// docker.sock host; the program is always this constant.
const BUILDER_PROGRAM = "/opt/thinx/thinx-device-api/builder";

// The flags the API emits (lib/thinx/builder.js buildArgs), plus the bare
// `--dry-run`. The bash builder also parses --alias and --open, but the API
// never sends them, so they stay refused. A new builder flag in the API needs
// a worker release first, or its jobs fail with "Invalid argv".
const ALLOWED_ARGV_FLAGS = ["owner", "udid", "fcid", "mac", "git", "branch", "id", "workdir", "env"];

// --env carries the owner's custom environment variables as JSON, which may
// hold credentials (T-23-13). Every log line that shows a job's argv or its
// legacy cmd goes through these two helpers.
const redactArgv = (argv) => Array.isArray(argv)
    ? argv.map((arg) => ((typeof(arg) === "string") && (arg.indexOf("--env=") === 0)) ? "--env=<redacted>" : arg)
    : argv;

// The legacy cmd holds the same --env JSON, shell-quoted and possibly split
// on spaces, and the API always appends it last; everything from the first
// --env= onward is dropped. Over-redacting a log line is harmless.
const redactCommand = (cmd) => {
    if (typeof(cmd) !== "string") return cmd;
    const at = cmd.indexOf("--env=");
    return (at === -1) ? cmd : cmd.slice(0, at) + "--env=<redacted>";
};

module.exports = class Worker {

    constructor(build_server) {
        this.client_id = null;
        this.socket = io(build_server);
        console.log(`${new Date().getTime()} -= THiNX Cloud Build Worker ${version} =-`);
        this.setupSocket(this.socket);
        this.socket_id = null;
        this.running = false;
    }

    //
    // Main Logic
    //

    failJob(sock, job, details) {
        let copy = JSON.parse(JSON.stringify(job));
        copy.status = "Failed";
        copy.details = details;
        sock.emit('job-status', copy);
        this.running = false;
    }

    validateJob(sock, job) {

        if (typeof(job.argv) !== "undefined") {
            // A job that carries argv at all is an argv job: a malformed argv is
            // refused, never retried through the legacy cmd shell path.
            if (!Array.isArray(job.argv) || !this.validateArgv(job.argv)) {
                this.failJob(sock, job, "Invalid argv");
                console.log(`${new Date().getTime()} Remote command contains unexpected shell metacharacters; this security incident should be reported.`);
                return false;
            }
        } else if (typeof(job.cmd) === "undefined") {
            this.failJob(sock, job, "Missing command");
            return false;
        } else {
            let command = job.cmd;
            if (!this.isArgumentSafe(command)) {
                console.log(`${new Date().getTime()} Remote command contains unexpected shell metacharacters; this security incident should be reported.`);
                return false;
            }
        }

        if (typeof(job.build_id) === "undefined") {
            this.failJob(sock, job, "Missing build_id");
            return false;
        }

        if (typeof(job.udid) === "undefined") {
            this.failJob(sock, job, "Missing udid");
            return false;
        }

        // Fail closed: a worker without a configured secret must never run remote jobs.
        const workerSecret = process.env.WORKER_SECRET;
        if (typeof(workerSecret) === "undefined" || workerSecret === null || workerSecret === "") {
            console.log(`${new Date().getTime()} [critical] WORKER_SECRET is not configured; refusing job. Set WORKER_SECRET to enable authenticated builds.`);
            return false;
        }

        if (typeof(job.secret) === "undefined" || job.secret === null) {
            this.failJob(sock, job, "Missing job secret");
            return false;
        }

        if (!this.secretsMatch(job.secret, workerSecret)) {
            this.failJob(sock, job, "Invalid job authentication");
            return false;
        }

        return true;
    }

    // Constant-time secret comparison to avoid timing side channels.
    // Returns true only on exact, equal-length match.
    secretsMatch(provided, expected) {
        if (typeof(provided) !== "string" || typeof(expected) !== "string") {
            return false;
        }
        const a = Buffer.from(provided);
        const b = Buffer.from(expected);
        if (a.length !== b.length) {
            return false;
        }
        return crypto.timingSafeEqual(a, b);
    }

    runJob(sock, job) {

        if (this.validateJob(sock, job)) {
            console.log(`${new Date().getTime()} Setting worker to running...`);
            this.running = true;
            if (Array.isArray(job.argv)) {
                // argv wins: when a job carries both, cmd is ignored.
                this.runArgv(job.argv, job.owner, job.build_id, job.udid, job.path, sock);
            } else {
                // D-03 removal signal: once worker logs stop showing this line, no
                // API sends cmd-only jobs any more and cmd + the shell path can go.
                // build_id only: never the secret, never the cmd (it may carry env JSON).
                console.log(`${new Date().getTime()} [warning] legacy cmd-only job ${job.build_id}: the API sent no argv; running through the shell path`);
                this.runShell(job.cmd, job.owner, job.build_id, job.udid, job.path, sock);
            }
        } else {
            console.log(`${new Date().getTime()} [critical] Job validation failed on this worker. Developer error, or attack attempt. No shell will be run.`);
        }
    }

    isBuildIDValid(build_id) {
        // build id may include [:alnum:] and - only
        var pattern = new RegExp(/^([a-zA-Z0-9-]+)$/);
        return (pattern.test(build_id));
    }

    isArgumentSafe(CMD) {
        if (typeof(CMD) !== "string") {
            return false;
        }
        // Reject shell metacharacters that enable command chaining, substitution,
        // piping or redirection. Legitimate build commands are a single program
        // invocation with `--flag=value` arguments and contain none of these.
        var dangerous = /[;&|`$()<>\n\r\\]/;
        return !dangerous.test(CMD);
    }

    // SEC-EXEC-02 (D-02): every argv element must be a string that is either the
    // bare `--dry-run` or `--<name>=<value>` with <name> in ALLOWED_ARGV_FLAGS, and
    // must pass isArgumentSafe. shell:false already stops the metacharacters from
    // reaching a shell here, but the bash builder later evals parsed YAML and may
    // interpolate these values, and the legacy path refused the same characters
    // over the whole command string, so the acceptance set stays exactly the same.
    // An element that does not start with `--` (e.g. a program path) is refused:
    // the job can never name the program.
    validateArgv(argv) {
        if (!Array.isArray(argv) || argv.length === 0) {
            return false;
        }
        for (let arg of argv) {
            if (typeof(arg) !== "string") {
                return false;
            }
            if (arg !== "--dry-run") {
                let match = /^--([a-z]+)=/.exec(arg);
                if (match === null || ALLOWED_ARGV_FLAGS.indexOf(match[1]) === -1) {
                    return false;
                }
            }
            if (!this.isArgumentSafe(arg)) {
                return false;
            }
        }
        return true;
    }

    runArgv(argv, owner, build_id, udid, path, socket, callback) {

        // Validate using whitelist regex to prevent command injection
        if (!this.isBuildIDValid(build_id)) {
            console.log(`"[OID:${owner}] [BUILD_FAILED] Owner submitted invalid request...`);
            this.running = false; // release the guard; no build was started
            if (typeof(callback) === "function") callback();
            return;
        }

        // Sanitize against path traversal
        build_id = build_id.replace(/\./g, '');
        build_id = build_id.replace(/\\/g, '');
        build_id = build_id.replace(/\//g, '');

        // Defence in depth: validateJob already checked argv, but runArgv must
        // never spawn an argv it has not validated itself.
        if (!this.validateArgv(argv)) {
            console.log(`[error] argv invalid, suspected command injection, exiting!`);
            this.running = false; // release the guard; no build was started
            if (typeof(callback) === "function") callback();
            return;
        }

        console.log(`"[OID:${owner}] [BUILD_STARTED] Worker started...`);
        // --env carries the owner's custom environment variables as JSON, which
        // may hold credentials, so its value stays out of the log.
        console.log(`[info] worker runArgv ${redactArgv(argv).join(" ")}`);

        let shell = exec.spawn(BUILDER_PROGRAM, argv, { shell: false });
        this.attachBuildHandlers(shell, owner, build_id, udid, path, socket, callback);
    }

    runShell(CMD, owner, build_id, udid, path, socket, callback) {

        // Prevent injection through git, branch

        CMD = CMD.replace("./builder", "/opt/thinx/thinx-device-api/builder");

        // Validate using whitelist regex to prevent command injection
        if (!this.isBuildIDValid(build_id)) {
            console.log(`"[OID:${owner}] [BUILD_FAILED] Owner submitted invalid request...`);
            this.running = false; // release the guard; no build was started
            if (typeof(callback) === "function") callback();
            return;
        }

        // Sanitize against path traversal
        build_id = build_id.replace(/\./g, '');
        build_id = build_id.replace(/\\/g, '');
        build_id = build_id.replace(/\//g, '');

        console.log(`"[OID:${owner}] [BUILD_STARTED] Worker started...`);

        // preprocess
        let tomes = CMD.split(" ");

        for (let tome of tomes) {
            if ( (tome.indexOf("--git=") !== -1) || (tome.indexOf("--branch=") !== -1)) {
                if (!this.isArgumentSafe(tome)) {
                    console.log(`[error] Tome ${tome} invalid, suspected command injection, exiting!`);
                    this.running = false; // release the guard; no build was started
                    if (typeof(callback) === "function") callback();
                    return;
                }
            }
        }

        let command = tomes.join(" ");
        console.log(`[info] worker runShell command: ${redactCommand(command)}`);
        
        // deepcode ignore CommandInjection: this is expected functionality, risk should be accepted.
        let shell = exec.spawn(command, { shell: true });
        this.attachBuildHandlers(shell, owner, build_id, udid, path, socket, callback);
    }

    // Wires the build child process to the API: log streaming, JOB-RESULT parsing,
    // the build.log append, the Failed status on a non-zero exit, the socket
    // disconnect and the release of the running guard. Shared by runShell (legacy
    // cmd) and runArgv, so both paths report a build identically.
    attachBuildHandlers(shell, owner, build_id, udid, path, socket, callback) {

        let build_start = new Date().getTime();

		shell.stdout.on("data", (data) => {
			var string = data.toString();
            var logline = string;
            
            logline = logline.replace(/\r\r/g, '');
			logline = logline.replace(/\n\n/g, '');

			if (logline.length > 1) {
                console.log(logline);

				if (logline.indexOf("JOB-RESULT") !== -1) {
                    
                    // parses "[86ad8d90-46e8-11eb-a48a-b59a7e739f77] »» JOB-RESULT:" {...
                    let start_pos = logline.indexOf("{");
                    let annotation_string = logline.substr(start_pos);

                    let status_object = {
                        udid: udid,
                        state: "Failed",
                        build_id: build_id, 
                        owner: owner
                    };

                    try {
                        let annotation_json = JSON.parse(annotation_string);
                        status_object = annotation_json;
                        
                    } catch (e) {
                        console.log(`[error] Annotation status in '${annotation_string}' not parsed.`);
                    }

                    let elapsed_hr;
                    let build_time = (new Date().getTime() - build_start)/1000; // to seconds
                    if (build_time < 60) {
                        elapsed_hr = build_time + " seconds";
                    } else {
                        let minutes = Math.floor(build_time/60);
                        let seconds = Math.floor(build_time % 60);
                        elapsed_hr = minutes + " minutes " + seconds + " seconds";
                    }

                    console.log(`[info] BUILD TIME: ${elapsed_hr}`);

                    status_object.elapsed = build_time;
                    status_object.elapsed_hr = elapsed_hr;
                    
                    status_object.completed = true;
                    socket.emit('job-status', status_object); // should be called job-result everywhere, always indiates completion

                    // calculate build time
				}
            }

            // Something must write to build_path/build.log where the file is tailed from to websocket...
            var build_log_path = path + "/" + build_id.replace(/\//g, '\\\\') + "/build.log";
            fs.ensureFile(build_log_path, function (err) {
                if (err) {
                    console.log(`[error] Log file could not be created: ${err}`);
                } else {
                    // deepcode ignore PT: it's expected to be allowed to limit access
                    fs.fchmodSync(fs.openSync(build_log_path), 0o665);
                    chmodr(path + "/" + build_id, 0o665, (cherr) => {
                        if (cherr) {
                            console.log(`[error] Failed to execute chmodr ${cherr}`);
                        } else {
                            // deepcode ignore PT: the path is internally built
                            fs.appendFileSync(build_log_path, logline);
                        }
                    });
                }
            });

            socket.emit('log', logline + "\n");
            
        }); // end shell on out data
        
        var dstring = "unknown";

		shell.stderr.on("data", (data) => {
			let ddstring = data.toString();

			// Keep the latest stderr so the exit handler below reports a real
			// reason instead of the "unknown" placeholder.
			dstring = ddstring;

			// Do NOT fail the build just because stderr contains "fatal:".
			// Benign git output matches it constantly:
			//   `git describe --abbrev=0 --tags` on a repo with no tags prints
			//     fatal: No names found, cannot describe anything.
			//   which getTag() already handles by returning "1.0", and every
			//   SSH key that is not the right one prints
			//     fatal: Could not read from remote repository.
			//   before the next key succeeds.
			// This handler used to emit state:"Failed" AND clear this.running
			// mid-build, so a build that went on to compile successfully was
			// recorded as failed, no firmware was registered, and the worker
			// was handed back to the queue while it was still busy. The exit
			// code decides the outcome -- see shell.on("exit") below.
			console.log(`[OID:${owner}] [BUILD_STDERR] ${ddstring.trim()}`);
		}); // end shell on error data

		shell.on("error", (err) => {
            // spawn failed to launch (e.g. ENOENT); without this the 'error' event
            // would be unhandled and the running guard would never be released.
            console.log(`[OID:${owner}] [BUILD_FAILED] Worker failed to start build: ${err}`);
            this.running = false;
            socket.emit('job-status', {
                udid: udid,
                build_id: build_id,
                state: "Failed",
                reason: String(err)
            });
            if (typeof(callback) === "function") callback(err);
		}); // end shell on error

		shell.on("exit", (code) => {

            console.log(`[OID:${owner}] [BUILD_COMPLETED] with code ${code}`);
            this.running = false;

            if (code > 0) {
                socket.emit('job-status', {
                    udid: udid,
                    build_id: build_id, 
                    state: "Failed",
                    reason: dstring
                });
            }

            const close_underlying_connection = true; // should be true, having it false does not help failing builds
            if (typeof(socket.disconnect) === "function") {
                socket.disconnect(close_underlying_connection);
            }

            if (typeof(callback) === "function") callback(code);

		}); // end shell on exit
	}

    setupSocket(socket) {
        
        // Connectivity Events

        socket.on('connect', () => { 
            socket.emit('register', { status: "Hello from BuildWorker.", id: this.socket_id, running: this.running });
        });

        socket.on('disconnect', () => { 
            console.log(`${new Date().getTime()} » Worker socket disconnected.`);
        });

        // either by directly modifying the `auth` attribute
        socket.on("connect_error", () => {
            if ((typeof(process.env.WORKER_SECRET) !== "undefined")) {
                if (typeof(socket.auth) !== "undefined") {
                    socket.auth.token = process.env.WORKER_SECRET;
                    console.log(`${new Date().getTime()} connect_error attempt to resolve using WORKER_SECRET`);
                }
                setTimeout(function(){
                    socket.connect();
                }, 10000);
            }
        });

        // Business Logic Events

        socket.on('client id', (data) => { 
            if (this.client_id === null) {
                console.log(`${new Date().getTime()} » Worker received initial client id: ${data}`);
            } else {
                console.log(`${new Date().getTime()} » Worker re-assigned a new client id: ${data}`);
            }
            this.client_id = data;
        });

        socket.on('job', (data) => { 
            if (this.running == true) {
                console.log(`${new Date().getTime()} This worker is already running... passing job ${data}`);
                return;
            }
            // Ignore empty payloads before dereferencing them (data.path below).
            if (data === null || typeof(data) === "undefined") {
                console.log(`${new Date().getTime()} [warning] Ignoring empty job payload.`);
                return;
            }
            // Prevent path traversal by rejecting insane values
            if (typeof(data.path) !== "undefined" && data.path.indexOf("..") !== -1) {
                console.log(`${new Date().getTime()} [error] Invalid path (no path traversal allowed).`);
                return;
            }
            // The job secret authenticates the API (WORKER_SECRET), and argv/cmd
            // carry the owner's --env payload; none of them reach the log.
            let loggable = data;
            if (typeof(data) === "object") {
                loggable = Object.assign({}, data);
                if (typeof(data.argv) !== "undefined") loggable.argv = redactArgv(data.argv);
                if (typeof(data.cmd) !== "undefined") loggable.cmd = redactCommand(data.cmd);
                if (typeof(data.secret) !== "undefined") loggable.secret = "<redacted>";
            }
            console.log(new Date().getTime(), `» Worker has new job:`, loggable);
            // runJob sets this.running = true and starts the build asynchronously
            // (runShell uses child_process.spawn). The flag is cleared only when the
            // build actually finishes — in shell 'exit'/'error', the fatal-stderr
            // branch, failJob, or runShell's early validation returns. Do NOT clear it
            // here: the build is still in progress, and clearing it would let a second
            // job start concurrently on this worker.
            if (typeof(data.mock) === "undefined" || data.mock !== true) {
                this.client_id = data;
                this.runJob(socket, data);
            } else {
                console.log(`${new Date().getTime()} [info] » This is a MOCK job`);
                this.runJob(socket, data);
            }
        });
    }

    loop() {
        if (!this.running) {
            this.socket.emit('poll', 'true');
        } else {
            console.log(`${new Date().getTime()} [info] » Skipping poll cron (job still running and did not timed out).`);
        }
    }
}