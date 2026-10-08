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
const INFER = path.join(__dirname, "infer");

function hasCommand(cmd) {
    return child_process.spawnSync("sh", ["-c", `command -v ${cmd}`]).status === 0;
}

// At least one of the two must exist, or describe.each fails on an empty table.
const SHELLS = [];
if (hasCommand("bash")) SHELLS.push(["bash"]);
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
//   fw_size           the build (service create / run) writes a firmware image
//                     of this many bytes to <workspace>/build/firmware.bin
//   fw_symlink        ... or a symlink to this path instead
//   run_rc            exit status of `docker run` (default 0)
//   attached_blocks   `service create` without --detach blocks, as docker does
//                     for a task that fails under restart-condition=none
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
    name=""; prev=""; ws=""
    for a in "$@"; do
      if [ "$prev" = "--name" ]; then name="$a"; fi
      case "$a" in type=bind,source=*,destination=/opt/workspace)
        ws=\${a#type=bind,source=}; ws=\${ws%,destination=/opt/workspace} ;;
      esac
      prev="$a"
    done
    echo "$name" > "$S/name"
    # Without --detach, docker waits for the service to converge; a task that
    # fails under restart-condition=none never does, so it never returns.
    case " $* " in *" --detach "*) ;; *)
      if [ -f "$S/attached_blocks" ]; then
        echo "$$" > "$S/create_pid"
        echo "overall progress: 0 out of 1 tasks"
        echo "1/1: task: non-zero exit (1)"
        exec sleep 300
      fi ;;
    esac
    # the build itself: the image writes its output into the workspace
    if [ -f "$S/fw_size" ] && [ -n "$ws" ]; then
      head -c "$(cat "$S/fw_size")" /dev/zero > "$ws/build/firmware.bin"
    fi
    if [ -f "$S/fw_symlink" ] && [ -n "$ws" ]; then
      ln -s "$(cat "$S/fw_symlink")" "$ws/build/firmware.bin"
    fi
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
case "$1" in
  pull)
    exit 0 ;;
  run)
    ws=""; prev=""
    for a in "$@"; do
      if [ "$prev" = "-v" ]; then
        case "$a" in *:/opt/workspace) ws=\${a%:/opt/workspace} ;; esac
      fi
      prev="$a"
    done
    echo "stub build output"
    if [ -f "$S/fw_size" ] && [ -n "$ws" ]; then
      head -c "$(cat "$S/fw_size")" /dev/zero > "$ws/build/firmware.bin"
    fi
    if [ -f "$S/fw_symlink" ] && [ -n "$ws" ]; then
      ln -s "$(cat "$S/fw_symlink")" "$ws/build/firmware.bin"
    fi
    rc=$(cat "$S/run_rc" 2>/dev/null || echo 0)
    if [ "$rc" = 0 ]; then echo "THiNX BUILD SUCCESSFUL."; else echo "THiNX BUILD FAILED: $rc"; fi
    exit "$rc" ;;
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
    // swarmbuild lists the service once right after creating it, before the
    // poll loop; that call sees a fresh 0/1 service (or none at all).
    const initial = scenario.ls[0] === "GONE" ? "GONE" : "0/1";
    fs.writeFileSync(path.join(stubDir, "ls_seq"), [initial].concat(scenario.ls).join("\n") + "\n");
    fs.writeFileSync(path.join(stubDir, "ps_seq"), (scenario.ps || ["Running 1 second ago|"]).join("\n") + "\n");
    fs.writeFileSync(path.join(stubDir, "logs_final"), scenario.logs || "");
    if (scenario.hang) fs.writeFileSync(path.join(stubDir, "logs_hang"), "");
    if (scenario.attachedBlocks) fs.writeFileSync(path.join(stubDir, "attached_blocks"), "");

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
    const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c", script]),
        { env, timeout: scenario.timeout || 20000 });

    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    const calls = read(path.join(stubDir, "calls.log"));
    const bgPid = parseInt(read(path.join(stubDir, "bg_pid")), 10);
    if (bgPid) lingering.push(bgPid);
    const createPid = parseInt(read(path.join(stubDir, "create_pid")), 10);
    if (createPid) lingering.push(createPid);
    return {
        spawnError: res.error,
        rc: parseInt(read(rcPath), 10),
        out: read(outPath),
        log: read(logPath),
        calls,
        // polls = `service ls` calls made by the loop, after the initial listing
        polls: calls.split("\n").filter((l) => l.startsWith("service ls")).length - 1,
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
        expect(r.polls).toBe(4);
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
        expect(r.polls).toBe(2);
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
        expect(r.polls).toBe(1);
    });

    test("a service that disappears ends the loop as a failure", () => {
        const r = runSwarmbuild(shell, { ls: ["GONE"] });
        expect(r.rc).not.toBe(0);
        expect(r.out).toContain("Service failure.");
        expect(r.out).not.toContain("Build completed.");
        expect(r.polls).toBe(1);
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
        expect(r.polls).toBe(3);
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

    // Production 2026-10-04: without --detach, `docker service create` waits
    // for the service to converge. A build task that fails fast (restart
    // condition none) never converges, so create never returned, the poll
    // loop never started and the worker hung until the service was removed.
    test("a fast-failing task ends on the failure path: the service is created detached", () => {
        const r = runSwarmbuild(shell, {
            ls: ["0/1"],
            ps: ["Failed 1 second ago|task: non-zero exit (1)"],
            logs: "THiNX BUILD FAILED: 1\n",
            attachedBlocks: true,
            timeout: 8000
        });
        expect(r.spawnError).toBeUndefined();
        const creates = r.calls.split("\n").filter((l) => l.startsWith("service create"));
        expect(creates).toHaveLength(1);
        expect(creates[0].split(" ")).toContain("--detach");
        expect(r.rc).not.toBe(0);
        expect(r.out).toContain("non-zero exit");
        expect(r.out).not.toContain("Build completed.");
        expect(r.log).toContain("THiNX BUILD FAILED");
        expect(r.rmCalls).toBe(1);
    });

    // Build services run repository content; with the docker socket they
    // would be root on the swarm node (T-23-14 containment).
    test("the build service is created without the docker.sock mount", () => {
        const r = runSwarmbuild(shell, {
            ls: ["0/1"],
            ps: ["Complete 1 second ago|"],
            logs: "THiNX BUILD SUCCESSFUL.\n"
        });
        expect(r.rc).toBe(0);
        const creates = r.calls.split("\n").filter((l) => l.startsWith("service create"));
        expect(creates).toHaveLength(1);
        expect(creates[0]).not.toContain("docker.sock");
        // the workspace, deploy and repos mounts are still there
        expect(creates[0]).toContain("destination=/opt/workspace");
        expect(creates[0]).toContain("destination=/mnt/data/deploy");
        expect(creates[0]).toContain("destination=/mnt/data/repos");
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

    // thinx-autoflood (build 0d9c2b60, 2026-10-04): four envs, thinx.yml sets
    // environment: d1_mini, and cmd.sh therefore built only .pio/build/d1_mini.
    test("thinx-autoflood keeps building: multi-env with environment d1_mini", () => {
        const dir = pioFixture(MULTI_ENV_INI, "platformio:\n  arch: esp8266\n  environment: d1_mini\n", ["d1_mini"]);
        const r = resolvePio(shell, dir);
        expect(r.rc).toBe(0);
        expect(r.err).toBe("");
        expect(r.env).toBe("d1_mini");
        expect(r.out).toBe(path.join(dir, ".pio", "build", "d1_mini", "firmware.bin"));
        expect(fs.existsSync(r.out)).toBe(true);
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

// --- micropython (suculent/micropython-docker-build) -------------------------
//
// Contract (builder-lib.sh upy_build, the image's cmd.sh and README): the
// repository is mounted at /opt/workspace, the image runs its own command,
// freezes the repository's *.py and writes /opt/workspace/build/firmware.bin;
// the worker deploys that file to DEPLOYMENT_PATH/firmware.bin when the build
// succeeded and the image is over 10000 bytes.

const UPY_IMAGE = "suculent/micropython-docker-build";

function upyRepo() {
    const dir = tmpDir("on2-upy-");
    const wd = path.join(dir, "repo");
    const dep = path.join(dir, "deploy");
    fs.mkdirSync(wd);
    fs.mkdirSync(dep);
    fs.writeFileSync(path.join(wd, "thinx.yml"), "micropython:\n  platform: esp8266\n  build:\n    type: firmware\n");
    fs.writeFileSync(path.join(wd, "main.py"), "import thinx\nthinx.main()\n");
    fs.writeFileSync(path.join(wd, "thinx.py"), "# thinx\n");
    return { dir, wd, dep };
}

// Runs `fn` (upy_build or upy_files) from builder-lib.sh against the stub
// docker. scenario: swarm, fwSize, fwSymlink(repo) -> link target, runRc, ls,
// ps, logs, before(repo).
function runUpy(shell, scenario, fn) {
    const repo = upyRepo();
    const stubDir = path.join(repo.dir, "stub");
    const binDir = path.join(repo.dir, "bin");
    fs.mkdirSync(stubDir);
    fs.mkdirSync(binDir);
    fs.writeFileSync(path.join(binDir, "docker"), DOCKER_STUB, { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, "ls_seq"), ["0/1"].concat(scenario.ls || ["1/1", "0/1"]).join("\n") + "\n");
    fs.writeFileSync(path.join(stubDir, "ps_seq"), (scenario.ps || ["Complete 1 second ago|"]).join("\n") + "\n");
    fs.writeFileSync(path.join(stubDir, "logs_final"), scenario.logs || "THiNX BUILD SUCCESSFUL.\n");
    if (scenario.fwSize !== undefined) fs.writeFileSync(path.join(stubDir, "fw_size"), String(scenario.fwSize));
    if (scenario.fwSymlink) fs.writeFileSync(path.join(stubDir, "fw_symlink"), scenario.fwSymlink(repo));
    if (scenario.runRc !== undefined) fs.writeFileSync(path.join(stubDir, "run_rc"), String(scenario.runRc));
    if (scenario.before) scenario.before(repo);

    const logPath = path.join(repo.dir, "build.log");
    const outPath = path.join(repo.dir, "out.txt");
    const rcPath = path.join(repo.dir, "rc.txt");
    const ofPath = path.join(repo.dir, "outfile.txt");
    fs.writeFileSync(logPath, "");
    const call = fn === "upy_files" ? 'upy_files "$WD" "$DEP"' : 'upy_build "$SWARM" "$WD" "$DEP" "$LOG"';
    const script = '. "$LIB"; ' + call + ' > "$OUT" 2>&1; echo "$?" > "$RCF"; printf "%s" "$UPY_OUTFILE" > "$OF"';
    const env = Object.assign({}, process.env, {
        PATH: binDir + ":" + process.env.PATH,
        STUB_DIR: stubDir, LIB, WD: repo.wd, DEP: repo.dep, LOG: logPath,
        OUT: outPath, RCF: rcPath, OF: ofPath, LC_ALL: "C",
        SWARM: scenario.swarm === false ? "false" : "true",
        SWARMBUILD_FIRST_POLL: "0", SWARMBUILD_POLL_INTERVAL: "0", SWARMBUILD_MAX_ITERATIONS: "8"
    });
    const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c", script]), { env, timeout: 20000 });
    const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "");
    const calls = read(path.join(stubDir, "calls.log"));
    return Object.assign(repo, {
        spawnError: res.error,
        rc: parseInt(read(rcPath), 10),
        out: read(outPath),
        log: read(logPath),
        outfile: read(ofPath),
        calls,
        creates: calls.split("\n").filter((l) => l.startsWith("service create")),
        runs: calls.split("\n").filter((l) => l.startsWith("run "))
    });
}

const deployed = (r) => path.join(r.dep, "firmware.bin");

describe.each(SHELLS)("micropython build under %s", (...shell) => {

    test("the build service mounts the repository at /opt/workspace and runs the image's own command", () => {
        const r = runUpy(shell, { fwSize: 20000 });
        expect(r.spawnError).toBeUndefined();
        expect(r.creates).toHaveLength(1);
        const argv = r.creates[0].split(" ").filter((a) => a.length > 0);
        expect(argv).toContain("type=bind,source=" + r.wd + ",destination=/opt/workspace");
        expect(argv[argv.length - 1]).toBe(UPY_IMAGE);
        expect(r.creates[0]).not.toContain("/micropython/esp8266");
        expect(r.creates[0]).not.toContain("--workdir");
    });

    test("a swarm build deploys build/firmware.bin to DEPLOYMENT_PATH/firmware.bin", () => {
        const r = runUpy(shell, { fwSize: 20000 });
        expect(r.rc).toBe(0);
        expect(r.outfile).toBe(deployed(r));
        expect(fs.statSync(deployed(r)).size).toBe(20000);
    });

    test("build/ is created fresh and writable for the image's unprivileged user", () => {
        const r = runUpy(shell, { fwSize: 20000 });
        expect(r.rc).toBe(0);
        expect(fs.lstatSync(path.join(r.wd, "build")).isDirectory()).toBe(true);
        expect(fs.statSync(path.join(r.wd, "build")).mode & 0o777).toBe(0o777);
    });

    test("an image of 10000 bytes or less is not deployed", () => {
        const r = runUpy(shell, { fwSize: 10000 });
        expect(r.rc).not.toBe(0);
        expect(r.outfile).toBe("");
        expect(fs.existsSync(deployed(r))).toBe(false);
        expect(r.log).toContain("below 10k");
    });

    test("a failed build task deploys nothing, even with an image on disk", () => {
        const r = runUpy(shell, {
            fwSize: 20000,
            ps: ["Failed 1 second ago|task: non-zero exit (1)"],
            logs: "THiNX BUILD FAILED: 1\n"
        });
        expect(r.rc).not.toBe(0);
        expect(r.outfile).toBe("");
        expect(fs.existsSync(deployed(r))).toBe(false);
    });

    test("a firmware.bin committed to the repository is never deployed", () => {
        const r = runUpy(shell, {
            before: (repo) => {
                fs.mkdirSync(path.join(repo.wd, "build"));
                fs.writeFileSync(path.join(repo.wd, "build", "firmware.bin"), "C".repeat(50000));
            }
        });
        expect(r.rc).not.toBe(0);
        expect(fs.existsSync(deployed(r))).toBe(false);
    });

    test("a build/ symlink in the repository is replaced, its target left alone", () => {
        let outside;
        const r = runUpy(shell, {
            fwSize: 20000,
            before: (repo) => {
                outside = path.join(repo.dir, "outside");
                fs.mkdirSync(outside, { mode: 0o700 });
                fs.writeFileSync(path.join(outside, "keep.txt"), "keep");
                fs.symlinkSync(outside, path.join(repo.wd, "build"));
            }
        });
        expect(r.rc).toBe(0);
        expect(fs.lstatSync(path.join(r.wd, "build")).isSymbolicLink()).toBe(false);
        expect(fs.statSync(outside).mode & 0o777).toBe(0o700);
        expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("keep");
        expect(fs.existsSync(path.join(outside, "firmware.bin"))).toBe(false);
    });

    test("a firmware.bin symlink is not followed into the deployment", () => {
        // e.g. a link to a worker-side file, which the deployment would serve
        const r = runUpy(shell, {
            fwSymlink: (repo) => {
                const target = path.join(repo.dir, "secret");
                fs.writeFileSync(target, "S".repeat(20000));
                return target;
            }
        });
        expect(r.rc).not.toBe(0);
        expect(fs.existsSync(deployed(r))).toBe(false);
    });

    test("without swarm, docker run mounts the repository at /opt/workspace", () => {
        const r = runUpy(shell, { swarm: false, fwSize: 20000 });
        expect(r.runs).toEqual(["run --cpus=1.0 --rm -t -v " + r.wd + ":/opt/workspace " + UPY_IMAGE]);
        expect(r.rc).toBe(0);
        expect(r.outfile).toBe(deployed(r));
        expect(fs.statSync(deployed(r)).size).toBe(20000);
        expect(r.log).toContain("THiNX BUILD SUCCESSFUL.");
    });

    test("without swarm, a failing build container deploys nothing", () => {
        const r = runUpy(shell, { swarm: false, fwSize: 20000, runRc: 2 });
        expect(r.rc).not.toBe(0);
        expect(r.outfile).toBe("");
        expect(fs.existsSync(deployed(r))).toBe(false);
        expect(r.log).toContain("THiNX BUILD FAILED");
    });

    test("file mode copies the repository's *.py and names boot.py or main.py", () => {
        const r = runUpy(shell, {
            before: (repo) => {
                fs.mkdirSync(path.join(repo.wd, "modules"));
                fs.writeFileSync(path.join(repo.wd, "modules", "sensor.py"), "# sensor\n");
                fs.symlinkSync("/etc/hosts", path.join(repo.wd, "hosts.py"));
            }
        }, "upy_files");
        expect(r.rc).toBe(0);
        expect(r.outfile).toBe(path.join(r.dep, "main.py"));
        expect(fs.readdirSync(r.dep).sort()).toEqual(["main.py", "sensor.py", "thinx.py"]);
        expect(r.calls).toBe("");
    });

    test("file mode prefers boot.py", () => {
        const r = runUpy(shell, {
            before: (repo) => fs.writeFileSync(path.join(repo.wd, "boot.py"), "# boot\n")
        }, "upy_files");
        expect(r.rc).toBe(0);
        expect(r.outfile).toBe(path.join(r.dep, "boot.py"));
    });

    test("file mode without boot.py or main.py fails", () => {
        const r = runUpy(shell, {
            before: (repo) => {
                fs.unlinkSync(path.join(repo.wd, "main.py"));
            }
        }, "upy_files");
        expect(r.rc).not.toBe(0);
        expect(r.outfile).toBe("");
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

    // The non-swarm path starts builder images with `docker run`; inside a
    // container it used to add -v /var/run/docker.sock:/var/run/docker.sock
    // through DOCKER_PREFIX. None of the builder images call docker.
    test("no docker run of a builder image passes the docker socket", () => {
        const code = (text) => text.split("\n").filter((l) => !/^\s*#/.test(l));
        // micropython's docker run lives in builder-lib.sh (upy_build)
        const runs = code(builder).concat(code(lib)).filter((l) => /\bdocker run\b/.test(l));
        expect(runs.length).toBeGreaterThanOrEqual(6);
        for (const l of runs) {
            expect(l).not.toContain("docker.sock");
        }
        // nothing (DOCKER_PREFIX or otherwise) adds a socket mount; the only
        // remaining mention is the operator message about the worker's own socket
        const mounts = code(builder).concat(code(lib))
            .filter((l) => /docker\.sock/.test(l) && !/^\s*echo\b/.test(l));
        expect(mounts).toEqual([]);
    });

    test("the micropython branch builds through upy_build / upy_files", () => {
        const start = builder.indexOf("\n    micropython)\n");
        expect(start).toBeGreaterThan(-1);
        const branch = builder.slice(start, builder.indexOf("\n\t\tnodemcu)\n", start));
        expect(branch).toMatch(/upy_build "\$SWARM" "\$WORKDIR" "\$DEPLOYMENT_PATH" "\$LOG_PATH"/);
        expect(branch).toMatch(/upy_files "\$WORKDIR" "\$DEPLOYMENT_PATH"/);
        // the old contract: modules/ only, a --workdir the image does not have
        expect(branch).not.toContain("/micropython/esp8266");
        expect(branch).not.toContain("/modules:");
        // the old firmware loop deleted the repository's own *.py
        expect(branch).not.toMatch(/rm -rf \$FSPATH/);
    });

    // The mongoose branch used to run `"$DCMD"` -- quoted, so bash looked
    // for one executable literally named "docker run --cpus=1.0 ..." and no
    // build ever started -- and mounted /opt/mongoose-builder, while swarmbuild
    // mounts /opt/workspace like every other image: swarm builds ran in an
    // empty directory.
    test("the mongoose branch runs docker unquoted, logged, on /opt/workspace", () => {
        const start = builder.indexOf("\n    mongoose)\n");
        expect(start).toBeGreaterThan(-1);
        const end = builder.indexOf("\n\t\tarduino)\n", start);
        expect(end).toBeGreaterThan(start);
        // comments explain the old contract, so judge the code lines only
        const branch = builder.slice(start, end).split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
        expect(branch).not.toContain('"$DCMD"');
        expect(branch).toMatch(/^\t*\$DCMD \| tee -a "\$\{LOG_PATH\}"$/m);
        expect(branch).toContain(":/opt/workspace suculent/mongoose-docker-build");
        expect(branch).not.toContain("/opt/mongoose-builder");
    });

    test.each(SHELLS)("builder and builder-lib.sh parse under %s", (...shell) => {
        const args = shell.slice(1).concat(["-n"]);
        expect(child_process.spawnSync(shell[0], args.concat([BUILDER])).status).toBe(0);
        expect(child_process.spawnSync(shell[0], args.concat([LIB])).status).toBe(0);
    });
});

// --- CI ----------------------------------------------------------------------
//
// CircleCI's `test` job used to run only `npm install`, so none of this ran
// before docker/publish pushed thinxcloud/worker:latest.

describe("CircleCI runs this suite before publishing", () => {

    const config = fs.readFileSync(path.join(__dirname, ".circleci", "config.yml"), "utf8");
    // the job body: from "  test:" under jobs to the next top-level key
    const job = (() => {
        const start = config.indexOf("\n  test:\n");
        if (start < 0) return "";
        const end = config.indexOf("\nworkflows:", start);
        return config.slice(start, end < 0 ? undefined : end);
    })();

    test("the test job runs npm test", () => {
        expect(job).not.toBe("");
        const commands = job.split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");
        expect(commands).toMatch(/^\s*(command:\s*)?npm (run )?test\b/m);
    });

    test("docker/publish still requires the test job", () => {
        const publish = config.slice(config.indexOf("- docker/publish:"));
        expect(publish).toMatch(/requires:\s*\n\s*- test\b/);
    });
});

// --- thinx.yml loader (T-23-14) ----------------------------------------------
//
// thinx.yml comes from the user's repository and the worker runs as root with
// docker.sock, so builder and infer must never eval it. thinx_yml_load assigns
// only allowlisted names, takes values literally and prints nothing.
//
// The payloads below only ever try to create a marker file inside a throwaway
// temp directory; the assertion is that the file never appears.

// Names each caller reads after loading thinx.yml.
const BUILDER_YML_NAMES = ["devsec_ssid", "devsec_pass", "devsec_ckey", "nodemcu_build_type",
    "nodemcu_build_float", "micropython_build_type", "micropython_platform"];
const INFER_YML_NAMES = ["platformio", "arduino", "micropython", "mongoose", "nodejs"];
const PROBE_NAMES = BUILDER_YML_NAMES.concat(INFER_YML_NAMES, ["PATH", "LD_PRELOAD", "THINX_ROOT",
    "WORKDIR", "SWARM", "HOME", "platformio_environment", "environment_target", "arduino_board",
    "devsec", "foo"]);

// Shell bookkeeping that `set` reports as changed between two calls.
const SET_NOISE = /^(_|rc|BASH_.*|PIPESTATUS|LINENO|RANDOM|SRANDOM|SECONDS|EPOCHSECONDS|EPOCHREALTIME|OPTIND|FUNCNAME|COLUMNS|LINES)$/;

function setNames(text) {
    const m = new Map();
    for (const line of text.split("\n")) {
        const r = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=/);
        if (r) m.set(r[1], (m.get(r[1]) || "") + line);
    }
    return m;
}

function ymlDir(content) {
    const dir = tmpDir("m46-yml-");
    fs.writeFileSync(path.join(dir, "thinx.yml"), content);
    return dir;
}

// Runs thinx_yml_load on `content` in a fresh shell (cwd = the fixture dir) and
// reports every probed variable, the loader's own output and which shell
// variables / environment entries it changed.
function loadYml(shell, content, scope) {
    const dir = ymlDir(content);
    const probe = PROBE_NAMES.map((n) =>
        `printf '%s\\037%s\\037%s\\036' ${n} "\${${n}+set}" "\${${n}}"`).join("; ");
    const script = '. "$LIB" || exit 9; rc=0; env | sort > "$T/env-before"; set > "$T/set-before"; ' +
        'thinx_yml_load "$DIR/thinx.yml" ' + scope + ' > "$T/out" 2>&1; rc=$?; ' +
        'set > "$T/set-after"; env | sort > "$T/env-after"; ' +
        'printf "RC\\037%s\\037\\036" "$rc"; ' + probe;
    const T = tmpDir("m46-state-");
    const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c", script]), {
        cwd: dir,
        env: Object.assign({}, process.env, { LIB, DIR: dir, T, LC_ALL: "C" }),
        encoding: "utf8"
    });
    const vars = {};
    let rc;
    for (const rec of res.stdout.split("\x1e")) {
        const f = rec.split("\x1f");
        if (f.length < 3) continue;
        if (f[0] === "RC") rc = Number(f[1]);
        else vars[f[0]] = { set: f[1] === "set", value: f[2] };
    }
    const read = (n) => (fs.existsSync(path.join(T, n)) ? fs.readFileSync(path.join(T, n), "utf8") : null);
    const before = setNames(read("set-before") || "");
    const after = setNames(read("set-after") || "");
    const changed = [];
    for (const [k, v] of after) {
        if (SET_NOISE.test(k)) continue;
        if (before.get(k) !== v) changed.push(k);
    }
    for (const k of before.keys()) {
        if (!SET_NOISE.test(k) && !after.has(k)) changed.push(k);
    }
    return {
        rc, vars, changed: changed.sort(), dir,
        out: read("out"),
        envSame: read("env-before") !== null && read("env-before") === read("env-after"),
        marker: fs.existsSync(path.join(dir, "PWNED")),
        stderr: res.stderr
    };
}

// parse_yaml as it was in ./infer before T-23-14: the reference for "same
// values as before". It only prints `export name="value"` lines; the test
// parses them in JS and applies the backslash rules eval used inside "...".
const OLD_PARSE_YAML = `parse_yaml()
{
    local prefix=$2
    local s
    local w
    local fs
    s='[[:space:]]*'
    w='[a-zA-Z0-9_]*'
    fs="$(echo @|tr @ '\\034')"
    sed -ne "s|^\\($s\\)\\($w\\)$s:$s\\"\\(.*\\)\\"$s\\$|\\1$fs\\2$fs\\3|p" \\
        -e "s|^\\($s\\)\\($w\\)$s[:-]$s\\(.*\\)$s\\$|\\1$fs\\2$fs\\3|p" "$1" |
    awk -F"$fs" '{
    indent = length($1)/2;
    vname[indent] = $2;
    for (i in vname) {if (i > indent) {delete vname[i]}}
        if (length($3) > 0) {
            vn=""; for (i=0; i<indent; i++) {vn=(vn)(vname[i])("_")}
            printf("export %s%s%s=\\"%s\\"\\n", "'"$prefix"'",vn, $2, $3);
        }
    }' | sed 's/_=/=/g'
}
`;

function oldParse(content) {
    const dir = ymlDir(content);
    const res = child_process.spawnSync("bash", ["-c", OLD_PARSE_YAML + 'parse_yaml "$1" ""', "_",
        path.join(dir, "thinx.yml")], { encoding: "utf8", env: Object.assign({}, process.env, { LC_ALL: "C" }) });
    const out = {};
    for (const line of res.stdout.split("\n")) {
        const m = line.match(/^export ([A-Za-z0-9_]*)="(.*)"$/);
        if (m) out[m[1]] = m[2].replace(/\\([\\"$`])/g, "$1");
    }
    return out;
}

// Layouts of the repository's own thinx.yml files; devsec values are fakes.
const LEGIT_YML = {
    "thinx-firmware-esp8266-pio": "# for Platformio-based ESP8266 CI builds\n\nplatformio:\n  environment: d1_mini\n\n" +
        "# arduino:\n#   platform: espressif\n#   arch: esp8266\n\n" +
        "# Those lines MUST be masked out in ENV prints!\ndevsec:\n  ckey: Zm9vYmFy+Zm9v/YmF6==\n" +
        "  ssid: FAKE-SSID-PIO\n  pass: FAKE-PASS-PIO\n\n# Per-device env-var injection\nenvironment:\n  target: src/environment.h\n",
    "spec/test_repositories/arduino": "# for ArduinoCore-based ESP8266 builds with SPIFFS\n\narduino:\n  platform: esp8266\n" +
        "  arch: esp8266\n  board: d1_mini_pro\n  flash_ld: eagle.flash.4m1m.ld\n  f_cpu: 80000000L\n  flash_size: 16M\n" +
        "  libs:\n    - ArduinoJSON\n  test:\n    - unit-test.sh\n\n  # Those lines MUST be masked out in ENV prints!\n" +
        "devsec:\n  ckey: FAKE-CKEY-ARD\n  ssid: FAKE-SSID-ARD\n  pass: FAKE-PASS-ARD\n",
    "thinx-firmware-esp32-pio": "platformio:\n  platform: espressif\n  arch: esp32\n  board: esp32\n  f_cpu: 240\n" +
        "  flash_size: 4M\n  libs:\n    - ArduinoJSON",
    "arduino-docker-build dummy (quoted)": "arduino:\n  platform: \"esp8266\"\n  arch: \"esp8266\"\n  board: \"nodemcuv2\"\n" +
        "devsec:\n  ssid: \"Fake Net 5G\"\n  pass: \"fake pass: 1\"\n  ckey: \"Zm9v+YmFy/0==\"\n",
    "nodemcu section": "nodemcu:\n  build_type: file\n  build_float: false\n",
    "micropython section": "micropython:\n  build_type: file\n  platform: esp32\n",
    // suculent/thinx-firmware-esp8266-upy (modules list shortened)
    "thinx-firmware-esp8266-upy": "micropython:\n  platform: esp8266\n  build:\n    type: firmware\n" +
        "  modules:\n    - _boot.py\n    - apa102.py\n    - webrepl.py\n",
    // what lib/thinx/builder.js writes back with YAML.stringify
    "API write-back (YAML.stringify)": "arduino:\n  platform: esp8266\ndevsec:\n  ckey: Q2tleQ==\n  ssid: \"#home net\"\n" +
        "  pass: \"a: b\\\"\\\\c\"\n"
};

const LEGIT_EXPECTED = {
    "thinx-firmware-esp8266-pio": { devsec_ckey: "Zm9vYmFy+Zm9v/YmF6==", devsec_ssid: "FAKE-SSID-PIO", devsec_pass: "FAKE-PASS-PIO" },
    "spec/test_repositories/arduino": { devsec_ckey: "FAKE-CKEY-ARD", devsec_ssid: "FAKE-SSID-ARD", devsec_pass: "FAKE-PASS-ARD" },
    "thinx-firmware-esp32-pio": {},
    "arduino-docker-build dummy (quoted)": { devsec_ssid: "Fake Net 5G", devsec_pass: "fake pass: 1", devsec_ckey: "Zm9v+YmFy/0==" },
    "nodemcu section": { nodemcu_build_type: "file", nodemcu_build_float: "false" },
    "micropython section": { micropython_build_type: "file", micropython_platform: "esp32" },
    "thinx-firmware-esp8266-upy": { micropython_build_type: "firmware", micropython_platform: "esp8266" },
    "API write-back (YAML.stringify)": { devsec_ckey: "Q2tleQ==", devsec_ssid: "#home net", devsec_pass: "a: b\"\\c" }
};

function expectOnly(r, expected) {
    expect(r.rc).toBe(0);
    expect(r.out).toBe("");
    expect(r.envSame).toBe(true);
    expect(r.marker).toBe(false);
    expect(r.changed).toEqual(Object.keys(expected).sort());
    for (const [k, v] of Object.entries(expected)) {
        expect([k, r.vars[k]]).toEqual([k, { set: true, value: v }]);
    }
}

describe.each(SHELLS)("thinx.yml loader under %s", (...shell) => {

    test.each(Object.keys(LEGIT_YML))("legit layout %s: same values as the old parse_yaml + eval", (name) => {
        const r = loadYml(shell, LEGIT_YML[name], "builder");
        expectOnly(r, LEGIT_EXPECTED[name]);
        if (hasCommand("bash")) {
            const ref = oldParse(LEGIT_YML[name]);
            for (const n of BUILDER_YML_NAMES) {
                expect([n, r.vars[n].set ? r.vars[n].value : undefined]).toEqual([n, ref[n]]);
            }
        }
    });

    test("CRLF line endings do not leave a carriage return in the value", () => {
        const r = loadYml(shell, "nodemcu:\r\n  build_type: file\r\n  build_float: false\r\n", "builder");
        expectOnly(r, { nodemcu_build_type: "file", nodemcu_build_float: "false" });
    });

    test.each([
        ["command substitution", "devsec:\n  ssid: $(touch PWNED)\n", "devsec_ssid", "$(touch PWNED)"],
        ["backticks", "devsec:\n  pass: `touch PWNED`\n", "devsec_pass", "`touch PWNED`"],
        ["double-quoted substitution", "devsec:\n  ckey: \"$(touch PWNED)\"\n", "devsec_ckey", "$(touch PWNED)"],
        ["quote break-out", "nodemcu:\n  build_type: x\"; touch PWNED; echo \"\n", "nodemcu_build_type", "x\"; touch PWNED; echo \""],
        ["escaped quote break-out", "nodemcu:\n  build_type: \"x\\\"; touch PWNED; echo \\\"\"\n", "nodemcu_build_type", "x\"; touch PWNED; echo \""],
        ["semicolon", "micropython:\n  build_type: firmware; touch PWNED\n", "micropython_build_type", "firmware; touch PWNED"],
        ["parameter expansion", "micropython:\n  platform: ${PATH}$HOME\n", "micropython_platform", "${PATH}$HOME"],
        ["top-level allowlisted name", "devsec_pass: $(touch PWNED)\n", "devsec_pass", "$(touch PWNED)"],
        ["value with = and _=", "devsec:\n  pass: a_=b=c\n", "devsec_pass", "a_=b=c"],
        ["literal backslash-n text", "devsec:\n  ssid: \"abc\\nPATH=/tmp/m46-evil\"\n", "devsec_ssid", "abc\\nPATH=/tmp/m46-evil"]
    ])("a %s value stays a literal string and runs nothing", (_label, yml, name, literal) => {
        const r = loadYml(shell, yml, "builder");
        expectOnly(r, { [name]: literal });
    });

    test("keys that are not on the allowlist set nothing", () => {
        const yml = "PATH: /tmp/m46-evil\nLD_PRELOAD: /tmp/m46-evil.so\nIFS: x\nTHINX_ROOT: /tmp/m46-evil\n" +
            "WORKDIR: /tmp/m46-evil\nSWARM: true\nHOME: /tmp/m46-evil\nfoo: $(touch PWNED)\nplatformio: true\n" +
            "nodejs: yes\nplatformio_environment: x\nenvironment:\n  target: src/evil.h\narduino:\n  board: evil\n" +
            "devsec:\n  ssid: FAKE-SSID\n";
        const r = loadYml(shell, yml, "builder");
        expectOnly(r, { devsec_ssid: "FAKE-SSID" });
        expect(r.vars.PATH.value).toBe(process.env.PATH);
        expect(r.vars.LD_PRELOAD.set).toBe(false);
        expect(r.vars.platformio.set).toBe(false);
        expect(r.vars.arduino_board.set).toBe(false);
    });

    test("the infer scope assigns only the platform section names", () => {
        const yml = "platformio: true\nnodejs: yes\nPATH: /tmp/m46-evil\narduino:\n  board: evil\n" +
            "devsec:\n  ssid: FAKE-SSID\nnodemcu:\n  build_type: file\n";
        const r = loadYml(shell, yml, "infer");
        expectOnly(r, { platformio: "true", nodejs: "yes" });
    });

    test("an unknown scope assigns nothing", () => {
        const r = loadYml(shell, "devsec:\n  ssid: FAKE-SSID\nplatformio: true\n", "PATH");
        expectOnly(r, {});
    });

    test.each([
        ["NUL byte", Buffer.from("devsec:\n  ssid: abc\0PATH=/tmp/m46-evil\n  pass: FAKE-OK\n"), "devsec_ssid"],
        ["carriage return inside the value", "devsec:\n  ssid: abc\rdef\n  pass: FAKE-OK\n", "devsec_ssid"],
        ["escape character", "devsec:\n  ssid: abc\x1b[2Jdef\n  pass: FAKE-OK\n", "devsec_ssid"],
        ["block scalar (|-)", "devsec:\n  ssid: |-\n    line1\n    PATH=/tmp/m46-evil\n  pass: FAKE-OK\n", "devsec_ssid"],
        ["folded plain scalar", "devsec:\n  ssid: first\n    second\n  pass: FAKE-OK\n", "devsec_ssid"],
        ["multi-line double-quoted scalar", "devsec:\n  ssid: \"first\n    $(touch PWNED)\"\n  pass: FAKE-OK\n", "devsec_ssid"]
    ])("a value with a %s is rejected and the variable left unset", (_label, yml, name) => {
        const r = loadYml(shell, yml, "builder");
        expectOnly(r, { devsec_pass: "FAKE-OK" });
        expect(r.vars[name].set).toBe(false);
    });

    test("a tab inside a value is kept", () => {
        const r = loadYml(shell, "devsec:\n  pass: a\tb\n", "builder");
        expectOnly(r, { devsec_pass: "a\tb" });
    });

    test("a missing file sets nothing and prints nothing", () => {
        const dir = tmpDir("m46-none-");
        const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c",
            '. "$LIB"; thinx_yml_load "$DIR/thinx.yml" builder; echo "RC=$?"; echo "SSID=${devsec_ssid-unset}"']), {
            env: Object.assign({}, process.env, { LIB, DIR: dir }), encoding: "utf8"
        });
        expect(res.stdout).toBe("RC=0\nSSID=unset\n");
        expect(res.stderr).toBe("");
    });
});

// --- infer_platform reads thinx.yml without eval ------------------------------

function inferFixture(files) {
    const dir = tmpDir("m46-infer-");
    for (const [rel, content] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
        fs.writeFileSync(path.join(dir, rel), content);
    }
    return dir;
}

function inferPlatform(shell, dir, extraEnv) {
    const res = child_process.spawnSync(shell[0], shell.slice(1).concat(["-c",
        '. "$INFER"; . "$LIB"; infer_platform "$DIR"']), {
        cwd: dir,
        env: Object.assign({}, process.env, { INFER, LIB, DIR: dir, LC_ALL: "C" }, extraEnv || {}),
        encoding: "utf8"
    });
    const lines = res.stdout.trim().split("\n");
    return { platform: lines[lines.length - 1], stderr: res.stderr, marker: fs.existsSync(path.join(dir, "PWNED")) };
}

describe.each(SHELLS)("infer_platform under %s", (...shell) => {

    test("a malicious thinx.yml runs nothing and the platform is still inferred", () => {
        const dir = inferFixture({
            "platformio.ini": SINGLE_ENV_INI,
            "thinx.yml": "platformio:\n  environment: $(touch PWNED)\ndevsec:\n  ssid: `touch PWNED`\n" +
                "  pass: x\"; touch PWNED; echo \"\nfoo: $(touch PWNED)\n"
        });
        const r = inferPlatform(shell, dir);
        expect(r.marker).toBe(false);
        expect(r.platform).toBe("platformio");
    });

    test.each([
        ["thinx-firmware-esp8266-pio", { "platformio.ini": SINGLE_ENV_INI, "thinx.yml": LEGIT_YML["thinx-firmware-esp8266-pio"] }, "platformio"],
        ["thinx-firmware-esp32-pio", { "platformio.ini": SINGLE_ENV_INI, "thinx.yml": LEGIT_YML["thinx-firmware-esp32-pio"] }, "platformio"],
        ["spec arduino repository", { "thinx/thinx.ino": "void setup(){}\n", "thinx.yml": LEGIT_YML["spec/test_repositories/arduino"] }, "arduino"],
        ["arduino-docker-build dummy", { "dummy/dummy.ino": "void setup(){}\n", "thinx.yml": LEGIT_YML["arduino-docker-build dummy (quoted)"] }, "arduino"],
        ["thinx-firmware-esp8266-upy", { "main.py": "import thinx\n", "thinx.py": "#\n", "thinx.yml": LEGIT_YML["thinx-firmware-esp8266-upy"] }, "micropython"]
    ])("legit layout %s keeps its platform", (_label, files, platform) => {
        const r = inferPlatform(shell, inferFixture(files));
        expect(r.platform).toBe(platform);
        expect(r.stderr).not.toMatch(/not found/);
    });

    test("a top-level platform scalar overrides the inferred platform", () => {
        const dir = inferFixture({ "platformio.ini": SINGLE_ENV_INI, "thinx.yml": "nodejs: true\n" });
        const r = inferPlatform(shell, dir);
        expect(r.platform).toBe("nodejs");
        expect(r.stderr).not.toMatch(/not found/);
    });

    test("platform names inherited from the caller's environment are ignored", () => {
        const dir = inferFixture({ "platformio.ini": SINGLE_ENV_INI, "thinx.yml": LEGIT_YML["thinx-firmware-esp8266-pio"] });
        const r = inferPlatform(shell, dir, { nodejs: "1", arduino: "1", mongoose: "1" });
        expect(r.platform).toBe("platformio");
    });
});

describe("thinx.yml is never evaluated (T-23-14)", () => {

    const code = (file) => fs.readFileSync(file, "utf8").split("\n").filter((l) => !/^\s*#/.test(l)).join("\n");

    test("builder, infer and builder-lib.sh contain no eval and no parse_yaml", () => {
        for (const f of [BUILDER, INFER, LIB]) {
            expect([f, /\beval\b/.test(code(f))]).toEqual([f, false]);
            expect([f, /parse_yaml/.test(code(f))]).toEqual([f, false]);
        }
    });

    test("builder and infer load thinx.yml through thinx_yml_load", () => {
        expect(code(BUILDER)).toMatch(/thinx_yml_load "\$YML" builder/);
        expect(code(INFER)).toMatch(/thinx_yml_load "\$YMLFILE" infer/);
    });

    test("builder never echoes a devsec value", () => {
        const leaks = code(BUILDER).split("\n").filter((l) => /\b(echo|printf)\b.*\$\{?devsec_(ssid|pass|ckey)/.test(l));
        expect(leaks).toEqual([]);
    });

    test.each(SHELLS)("infer parses under %s", (...shell) => {
        expect(child_process.spawnSync(shell[0], shell.slice(1).concat(["-n", INFER])).status).toBe(0);
    });
});
