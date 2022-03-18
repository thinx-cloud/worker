if (typeof(process.env.SQREEN_TOKEN) !== "undefined") {
    require('sqreen');
}

if (typeof(process.env.ROLLBAR_TOKEN) !== "undefined") {
    var Rollbar = require('rollbar');
    new Rollbar({
        accessToken: process.env.ROLLBAR_TOKEN,
        handleUncaughtExceptions: true,
        handleUnhandledRejections: true
    });
}

const exec = require("child_process");
const version = require('./package.json').version;
const io = require('socket.io-client');
const fs = require("fs-extra");
const chmodr = require('chmodr');
class Worker {

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

        if (typeof(job.cmd) === "undefined") {
            this.failJob(sock, job, "Missing command");
            return false;
        }

        let command = job.cmd;
        if (command.indexOf(";") !== -1) {
            console.log(`${new Date().getTime()} Remote command contains unexpected character ';'; this security incident should be reported.`);
            return false;
        }
        if (command.indexOf("&") !== -1) {
            console.log(`${new Date().getTime()} Remote command contains unexpected character '&'; this security incident should be reported.`);
            return false;
        }

        if (typeof(job.build_id) === "undefined") {
            this.failJob(sock, job, "Missing build_id");
            return false;
        }

        if (typeof(job.udid) === "undefined") {
            this.failJob(sock, job, "Missing udid");
            return false;
        }

        if (typeof(process.env.WORKER_SECRET) !== "undefined") {
            if (typeof(job.secret) === "undefined") {
                this.failJob(sock, job, "Missing job secret");
                return false;
            } else {
                if (job.secret === null) {
                    console.log(`${new Date().getTime()} Warning, JOB SECRET NULL! This will be error soon. ${job}`);
                    return false;
                } else {
                    if (job.secret.indexOf(process.env.WORKER_SECRET) !== 0) {
                        this.failJob(sock, job, "Invalid job authentication");
                        return false;
                    } 
                }
            }
        }

        return true;
    }

    runJob(sock, job) {

        if (this.validateJob(sock, job)) {
            console.log(`${new Date().getTime()} Setting worker to running...`);
            this.running = true;
            this.runShell(job.cmd, job.owner, job.build_id, job.udid, job.path, sock);
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
        var pattern = new RegExp("(?![;&]+)");
        return pattern.test(CMD);
    }

    runShell(CMD, owner, build_id, udid, path, socket) {

        // Prevent injection through git, branch

        CMD = CMD.replace("./builder", "/opt/thinx/thinx-device-api/builder");

        // Validate using whitelist regex to prevent command injection
        if (!this.isBuildIDValid(build_id)) {
            console.log(`"[OID:${owner}] [BUILD_FAILED] Owner submitted invalid request...`);
            return;
        }

        // Sanitize against path traversal
        build_id = build_id.replace(/\./g, '');
        build_id = build_id.replace(/\\/g, '');
        build_id = build_id.replace(/\//g, '');

        console.log(`"[OID:${owner}] [BUILD_STARTED] Worker started...`);

        // preprocess
        let tomes = CMD.split(" ");

        for (let tome in tomes) {
            if ( (tome.indexOf("--git=") !== -1) || (tome.indexOf("--branch=") !== -1)) {
                if (!this.isArgumentSafe(tome)) {
                    console.log(`[error] Tome ${tome} invalid, suspected command injection, exiting!`);
                    return;
                }
            }
        }

        console.log(`[info] worker runShell command: ${tomes}`);
        let command = tomes.join(" ");
        
        // deepcode ignore CommandInjection: this is expected functionality, risk should be accepted.
        let shell = exec.spawn(command, { shell: true }); // lgtm [js/command-line-injection]
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
            var build_log_path = path + "/" + build_id.replace(/\//g, '\\\\') + "/build.log"; // lgtm [js/path-injection]
            fs.ensureFile(build_log_path, function (err) { // lgtm [js/path-injection]
                if (err) {
                    console.log(`[error] Log file could not be created: ${err}`);
                } else {
                    // deepcode ignore PT: it's expected to be allowed to limit access
                    fs.fchmodSync(fs.openSync(build_log_path), 0o665); // lgtm [js/path-injection]
                    chmodr(path + "/" + build_id, 0o665, (cherr) => {
                        if (cherr) {
                            console.log(`[error] Failed to execute chmodr ${cherr}`);
                        } else {
                            // deepcode ignore PT: the path is internally built
                            fs.appendFileSync(build_log_path, logline); // lgtm [js/path-injection]
                        }
                    });
                }
            });

            socket.emit('log', logline + "\n");
            
        }); // end shell on out data
        
        var dstring = "unknown";

		shell.stderr.on("data", (data) => {
			let ddstring = data.toString();
			if (ddstring.indexOf("fatal:") !== -1) {
                this.running = false;
                socket.emit('job-status', {
                    udid: udid,
                    build_id: build_id, 
                    state: "Failed",
                    reason: ddstring
                });
			}
		}); // end shell on error data

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
            socket.disconnect(close_underlying_connection);
            
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
            // Prevent path traversal by rejecting insane values
            if (typeof(job.path) !== "undefined" && job.path.indexOf("..") !== -1) {
                console.log(`${new Date().getTime()} [error] Invalid path (no path traversal allowed).`);
                return;
            }
            console.log(new Date().getTime(), `» Worker has new job:`, data);
            if (typeof(data.mock) === "undefined" || data.mock !== true) {
                this.client_id = data;
                this.runJob(socket, data);
                this.running = false;
                console.log(`${new Date().getTime()} [info] » Job synchronously completed.`);
            } else {
                console.log(`${new Date().getTime()} [info] » This is a MOCK job`);
                this.runJob(socket, data);
                this.running = false;
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

// Init phase off-class

let srv = process.env.THINX_SERVER;
let worker = null;

if (typeof(srv) === "undefined" || srv === null) {
    console.log(`${new Date().getTime()} [critical] THINX_SERVER environment variable must be defined in order to build firmware with proper backend binding.`);
    process.exit(1);
} else {
    // fix missing http if defined in env file just like api:3000
    if (srv.indexOf("http") == -1) {
        srv = "http://" + srv;
    }
    console.log(`${new Date().getTime()} [info] » Starting build worker against ${srv}`);

    try {
        worker = new Worker(srv);
    } catch (e) {
        // in test environment there is a test worker running on additional port 3001 as well...
        console.log(`Caught exception ${e}`);
        let srv2 = srv1.replace(":3000", ":3001");
        // eslint-disable-next-line no-unused-vars
        worker = new Worker(srv2);
    }
}
