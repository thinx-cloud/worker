// Test needs server socket (API) to be mocked

const { createServer } = require("http");
const { Server } = require("socket.io");

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

    beforeAll((done) => {
        const httpServer = createServer();
        io = new Server(httpServer);
        httpServer.listen(() => {
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
    
            socket.on('job-status', (job_status) => {
                if ((typeof (this.workers[socket.id]) !== "undefined") && (this.workers[socket.id] !== null)) {
                    this.workers[socket.id].running = false;
                    console.log(`Setting worker ${this.workers[socket.id]} to not running.`);
                }
            });

        });
        done();
    });

    afterAll(() => {
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

    test ('runShell', (done) => {
        w.runShell(CMD, owner, build_id, udid, path, io, () => {
            done();
        });
    });

    test('socket must be closed/disconnected at the end', () => {
        w.close();
    });

});

