// Tests for the shell functions in builder-lib.sh (sourced by ./builder).
//
// swarmbuild runs against a stub `docker` placed first on PATH, so the poll
// loop's exit paths can be driven without a swarm. The platformio helpers run
// against fixture projects (platformio.ini + thinx.yml + fake .pio/build).
//
// ./builder runs under /bin/sh, which is busybox ash in the worker image, so
// every case runs under bash and, when it is installed, under busybox sh too.

const child_process = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const LIB = path.join(__dirname, "builder-lib.sh");
const BUILDER = path.join(__dirname, "builder");

function hasCommand(cmd) {
    return child_process.spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

const SHELLS = [["bash"]];
if (hasCommand("busybox")) SHELLS.push(["busybox", "sh"]);

const tmpDirs = [];
function tmpDir(prefix) {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    tmpDirs.push(d);
    return d;
}

const lingering = [];

afterAll(() => {
    for (const pid of lingering) {
        try { process.kill(pid, "SIGKILL"); } catch (e) { /* already gone */ }
    }
    for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

function isAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return false;
    }
}

// POSIX sh stub for the docker CLI. State lives in $STUB_DIR:
//   ls_seq / ps_seq   one REPLICAS / "CurrentState|Error" value per call; the
//                     last line repeats. ls_seq value GONE = service not listed.
//   logs_final        what `service logs` prints after its first call
//   logs_hang         first `service logs` call (the background one) blocks
//   calls.log         every invocation
const DOCKER_STUB = `#!/bin/sh
S="$STUB_DIR"
echo "$*" >> "$S/calls.log"
next_line() {
  n=$(cat "$2" 2>/dev/null || echo 0)
  n=$((n+1))
  echo "$n" > "$2"
  total=$(wc -l < "$1")
  if [ "$n" -gt "$total" ]; then n=$total; fi
  sed -n "\${n}p" "$1"
}
case "$1 $2" in
  "service create")
    name=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      prev="$a"
    done
    echo "$name" > "$S/name"
    echo "stubserviceid"
    exit 0 ;;
  "service ls")
    echo "ID   NAME   MODE   REPLICAS   IMAGE   PORTS"
    echo "aaa  thinx_thinx-api  replicated  1/1  thinx/api:latest"
    if [ -f "$S/removed" ]; then exit 0; fi
    line=$(next_line "$S/ls_seq" "$S/ls_count")
    if [ "$line" = "GONE" ]; then exit 0; fi
    echo "bbb  $(cat "$S/name")  replicated  $line  suculent/platformio-docker-build:latest"
    exit 0 ;;
  "service ps")
    if [ -f "$S/removed" ]; then echo "no such service: $3" >&2; exit 1; fi
    next_line "$S/ps_seq" "$S/ps_count"
    exit 0 ;;
  "service logs")
    n=$(cat "$S/logs_count" 2>/dev/null || echo 0)
    n=$((n+1))
    echo "$n" > "$S/logs_count"
    if [ "$n" -eq 1 ]; then
      echo "early: cloning workspace"
      if [ -f "$S/logs_hang" ]; then
        echo "$$" > "$S/bg_pid"
        exec sleep 300
      fi
      exit 0
    fi
    cat "$S/logs_final"
    exit 0 ;;
  "service rm")
    touch "$S/removed"
    echo "$3"
    exit 0 ;;
esac
echo "unexpected docker call: $*" >&2
exit 1
`;

function runSwarmbuild(shell, scenario) {
    const dir = tmpDir("lps-swarm-");
    const stubDir = path.join(dir, "stub");
    const binDir = path.join(dir, "bin");
    fs.mkdirSync(stubDir);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "docker"), DOCKER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, "ls_seq"), scenario.ls.join("\n") + "\n");
    fs.writeFileSync(path.join(stubDir, "ps_seq"), (scenario.ps || ["Running 1 second ago|"]).join("\n") + "\n");
    fs.writeFileSync(path.join(stubDir, "logs_final"), scenario.logs || "");
    if (scenario.hang) fs.writeFileSync(path.join(stubDir, "logs_hang"), "");

    const logPath = path.join(dir, "build.log");
    const outPath = path.join(dir, "out.txt");
    const rcPath = path.join(dir, "rc.txt");
    fs.writeFileSync(logPath, "");

    // stdout goes to a file, not the spawnSync pipe, so a background process
    // the function forgets to stop cannot keep spawnSync waiting.
    const script = '. "$LIB"; swarmbuild "$WORKDIR" suculent/platformio-docker-build "$LOG" > "$OUT" 2>&1; echo "$?" > "$RCF"';
    const env = Object.assign({}, process.env, {
        PATH: binDir + ":" + process.env.PATH,
        STUB_DIR: stubDir,
        LIB: LIB,
        WORKDIR: "/mnt/data/repos/owner/udid/build/repo",
        LOG: logPath,
        OUT: outPath,
        RCF: rcPath,
        LC_ALL: "C",
        SWARMBUILD_FIRST_POLL: "0",
        SWARMBUILD_POLL_INTERVAL: "0",
        SWARMBUILD_MAX_ITERATIONS: String(scenario.max || 8)
    });
    const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c", script]), { env, timeout: 20000 });

    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    const calls = read(path.join(stubDir, "calls.log"));
    const bgPid = parseInt(read(path.join(stubDir, "bg_pid")), 10);
    if (bgPid) lingering.push(bgPid);
    return {
        spawnError: res.error,
        rc: parseInt(read(rcPath), 10),
        out: read(outPath),
        log: read(logPath),
        calls,
        lsCalls: calls.split("\n").filter((l) => l.startsWith("service ls")).length,
        rmCalls: calls.split("\n").filter((l) => /^service rm thinx_build-/.test(l)).length,
        bgPid
    };
}

describe.each(SHELLS)("swarmbuild under %s", (...shell) => {

    test("a task that completes ends the loop on the success path", () => {
        const r = runSwarmbuild(shell, {
            // created (task still preparing) -> running -> exited
            ls: ["0/1", "1/1", "1/1", "0/1"],
            ps: ["Preparing 1 second ago|", "Complete 2 seconds ago|"],
            logs: "Building .pio/build/d1_mini/firmware.bin\nTHiNX BUILD SUCCESSFUL.\n"
        });
        expect(r.spawnError).toBeUndefined();
        expect(r.rc).toBe(0);
        expect(r.out).toContain("Build completed.");
        expect(r.out).not.toContain("Timed Out");
        expect(r.log).toContain("THiNX BUILD SUCCESSFUL.");
        expect(r.rmCalls).toBe(1);
        expect(r.lsCalls).toBe(4);
    });

    test("a task that exits non-zero ends the loop on the failure path", () => {
        const r = runSwarmbuild(shell, {
            ls: ["1/1", "0/1"],
            ps: ["Failed 1 second ago|task: non-zero exit (1)"],
            logs: "error: compilation terminated.\nTHiNX BUILD FAILED: 1\n"
        });
        expect(r.rc).not.toBe(0);
        expect(r.out).toContain("non-zero exit");
        expect(r.out).not.toContain("Build completed.");
        expect(r.log).toContain("THiNX BUILD FAILED");
        expect(r.rmCalls).toBe(1);
        expect(r.lsCalls).toBe(2);
    });

    test("a rejected task (missing image) ends the loop on the failure path", () => {
        const r = runSwarmbuild(shell, {
            ls: ["0/1"],
            ps: ["Rejected 1 second ago|No such image: suculent/platformio-docker-build:latest"],
            logs: ""
        });
        expect(r.rc).not.toBe(0);
        expect(r.out).toContain("No such image");
        expect(r.out).not.toContain("Build completed.");
        expect(r.rmCalls).toBe(1);
        expect(r.lsCalls).toBe(1);
    });

    test("a service that disappears ends the loop as a failure", () => {
        const r = runSwarmbuild(shell, { ls: ["GONE"] });
        expect(r.rc).not.toBe(0);
        expect(r.out).toContain("Service failure.");
        expect(r.out).not.toContain("Build completed.");
        expect(r.lsCalls).toBe(1);
    });

    test("MAX_ITERATIONS removes the service and fails", () => {
        const r = runSwarmbuild(shell, {
            ls: ["1/1"],
            ps: ["Running 1 minute ago|"],
            logs: "still compiling\n",
            max: 3
        });
        expect(r.rc).not.toBe(0);
        expect(r.out).toContain("Build Timed Out");
        expect(r.rmCalls).toBe(1);
        expect(r.lsCalls).toBe(3);
        expect(r.log).toContain("still compiling");
    });

    test("the background service-logs process is stopped when the loop ends", () => {
        const r = runSwarmbuild(shell, {
            ls: ["1/1", "0/1"],
            ps: ["Complete 1 second ago|"],
            logs: "THiNX BUILD SUCCESSFUL.\n",
            hang: true
        });
        expect(r.rc).toBe(0);
        expect(r.bgPid).toBeGreaterThan(0);
        expect(isAlive(r.bgPid)).toBe(false);
    });

    test("the first poll is quick and later polls stay at or under 30 s", () => {
        const env = Object.assign({}, process.env);
        delete env.SWARMBUILD_FIRST_POLL;
        delete env.SWARMBUILD_POLL_INTERVAL;
        delete env.SWARMBUILD_MAX_ITERATIONS;
        const script = '. "$LIB"; for i in 1 2 3 10 100; do swarmbuild_poll_delay "$i"; done';
        const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c", script]),
            { env: Object.assign(env, { LIB }), encoding: "utf8" });
        const delays = res.stdout.trim().split(/\s+/).map(Number);
        expect(delays).toHaveLength(5);
        expect(delays[0]).toBeGreaterThan(0);
        expect(delays[0]).toBeLessThanOrEqual(5);
        for (const d of delays.slice(1)) {
            expect(d).toBeGreaterThan(0);
            expect(d).toBeLessThanOrEqual(30);
        }
    });
});

// --- platformio environment selection ---------------------------------------

const MULTI_ENV_INI = `; autoflood-style project
[platformio]
src_dir = src

[env]
framework = arduino

[env:esp-relay]
platform = espressif8266
board = esp01_1m

[env:d1_mini]
platform = espressif8266
board = d1_mini

; [env:old_board]

[env:d1_mini-debug]
extends = env:d1_mini

[env:d1_mini_test]
extends = env:d1_mini
`;

const SINGLE_ENV_INI = `[env]
framework = arduino

[env:nodemcuv2]
platform = espressif8266
board = nodemcuv2
`;

// Every env got built (no --environment), plus the builder image's
// ./build/firmware.bin copy and esp32-style side images.
function pioFixture(ini, yml, envs) {
    const dir = tmpDir("lps-pio-");
    fs.writeFileSync(path.join(dir, "platformio.ini"), ini);
    if (yml !== null) fs.writeFileSync(path.join(dir, "thinx.yml"), yml);
    fs.mkdirSync(path.join(dir, "build"));
    fs.writeFileSync(path.join(dir, "build", "firmware.bin"), "last-env-copied");
    for (const e of envs) {
        const d = path.join(dir, ".pio", "build", e);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, "bootloader.bin"), "boot");
        fs.writeFileSync(path.join(d, "firmware.bin"), "image-" + e);
    }
    return dir;
}

function resolvePio(shell, dir) {
    const yml = path.join(dir, "thinx.yml");
    const script = 'cd "$DIR" || exit 9; . "$LIB"; pio_resolve_env "$DIR" "$YML"; rc=$?; ' +
        'echo "RC=$rc"; echo "ENV=$PIO_ENV"; echo "ERR=$PIO_ENV_ERROR"; ' +
        'if [ "$rc" -eq 0 ]; then echo "OUT=$(pio_outfile "$DIR" "$PIO_ENV")"; fi';
    const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c", script]), {
        env: Object.assign({}, process.env, { LIB, DIR: dir, YML: fs.existsSync(yml) ? yml : "", LC_ALL: "C" }),
        encoding: "utf8"
    });
    const all = res.stdout + res.stderr;
    const field = (k) => {
        const m = res.stdout.match(new RegExp("^" + k + "=(.*)$", "m"));
        return m ? m[1] : undefined;
    };
    return { all, rc: Number(field("RC")), env: field("ENV"), err: field("ERR"), out: field("OUT") };
}

describe.each(SHELLS)("platformio environment selection under %s", (...shell) => {

    const ENVS = ["esp-relay", "d1_mini", "d1_mini-debug", "d1_mini_test"];

    test("multi-env platformio.ini without platformio.environment fails before building", () => {
        const dir = pioFixture(MULTI_ENV_INI, "platformio:\n  arch: esp8266\n", ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(1);
        expect(r.err).toContain("multi-env platformio.ini: set platformio.environment in thinx.yml");
    });

    test("multi-env platformio.ini without any thinx.yml also fails", () => {
        const dir = pioFixture(MULTI_ENV_INI, null, ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(1);
        expect(r.err).toContain("multi-env platformio.ini");
    });

    test("the configured environment selects exactly .pio/build/<env>/firmware.bin", () => {
        const dir = pioFixture(MULTI_ENV_INI, "platformio:\n  arch: esp8266\n  environment: d1_mini_test\n", ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(0);
        expect(r.env).toBe("d1_mini_test");
        expect(r.out).toBe(path.join(dir, ".pio", "build", "d1_mini_test", "firmware.bin"));
    });

    test("a double-quoted environment and CRLF line endings are accepted", () => {
        const dir = pioFixture(MULTI_ENV_INI, "platformio:\r\n  environment: \"esp-relay\"\r\n  arch: esp8266\r\n", ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(0);
        expect(r.env).toBe("esp-relay");
        expect(r.out).toBe(path.join(dir, ".pio", "build", "esp-relay", "firmware.bin"));
    });

    test("an environment key under another section is not used", () => {
        const yml = "arduino:\n  environment: d1_mini\nplatformio:\n  arch: esp8266\n";
        const dir = pioFixture(MULTI_ENV_INI, yml, ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(1);
        expect(r.err).toContain("multi-env platformio.ini");
    });

    test("a single-env project keeps building and deploys that env's image", () => {
        const dir = pioFixture(SINGLE_ENV_INI, "platformio:\n  arch: esp8266\n", ["nodemcuv2"]);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(0);
        expect(r.env).toBe("nodemcuv2");
        expect(r.out).toBe(path.join(dir, ".pio", "build", "nodemcuv2", "firmware.bin"));
    });

    test.each([
        ["path traversal", "../../../etc"],
        ["dot-dot", ".."],
        ["space", "\"d1 mini\""],
        ["leading dash", "-x"],
        ["command substitution", "$(touch PWNED)"],
        ["backticks", "`touch PWNED`"],
        ["too long", "a".repeat(65)]
    ])("an invalid environment name is refused (%s)", (_label, value) => {
        const dir = pioFixture(MULTI_ENV_INI, "platformio:\n  environment: " + value + "\n", ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(1);
        expect(r.err).toMatch(/platformio\.environment/);
        expect(r.out).toBeUndefined();
        expect(fs.existsSync(path.join(dir, "PWNED"))).toBe(false);
    });

    test("reading thinx.yml never prints its other values (devsec secrets)", () => {
        const yml = "devsec:\n  ssid: SECRET-SSID-VALUE\n  pass: SECRET-PASS-VALUE\n  ckey: SECRET-CKEY-VALUE\n" +
            "platformio:\n  arch: esp8266\n";
        const dir = pioFixture(MULTI_ENV_INI, yml, ENVS);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(1);
        expect(r.all).not.toContain("SECRET-");
    });
});

// --- wiring into ./builder ---------------------------------------------------

describe("builder wiring", () => {

    const lib = fs.readFileSync(LIB, "utf8");
    const builder = fs.readFileSync(BUILDER, "utf8");

    test("grep tests use exit status, not $(... grep -q ...) or escaped quotes", () => {
        expect(lib).not.toMatch(/\$\([^)]*grep -q/);
        expect(builder).not.toMatch(/\$\([^)]*grep -q/);
        expect(lib).not.toMatch(/grep -q \\"/);
    });

    test("the platformio branch resolves the environment before it builds", () => {
        const start = builder.indexOf("\n\t\tplatformio)\n");
        expect(start).toBeGreaterThan(-1);
        const branch = builder.slice(start, builder.indexOf("\n\t*)\n", start));
        const resolveAt = branch.indexOf("pio_resolve_env");
        expect(resolveAt).toBeGreaterThan(-1);
        expect(resolveAt).toBeLessThan(branch.indexOf("swarmbuild "));
        expect(resolveAt).toBeLessThan(branch.indexOf("docker run"));
        expect(branch).not.toContain('find . -name "*.bin" | head -n 1');
    });

    test("builder and builder-lib.sh parse under bash", () => {
        expect(child_process.spawnSync("bash", ["-n", BUILDER]).status).toBe(0);
        expect(child_process.spawnSync("bash", ["-n", LIB]).status).toBe(0);
    });
});
