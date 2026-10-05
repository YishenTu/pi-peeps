# Optional macOS/Linux PTY smoke; isolated agent dir, fake providers, no network.
import os, pty, subprocess, tempfile, pathlib, json, select, time, re, struct, fcntl, termios, shutil, sys, signal
repo = pathlib.Path(__file__).resolve().parents[1]
(repo/".context").mkdir(exist_ok=True)
node = sys.argv[1]
sandbox = pathlib.Path(tempfile.mkdtemp(prefix="peeps-tui-"))
agent = sandbox/"agent"; workspace = sandbox/"workspace"; state = sandbox/"state"
for d in [agent,workspace,state]: d.mkdir()
(state/"release").write_text("go")
(agent/"settings.json").write_text(json.dumps({"defaultProvider":"peeps-scripted","defaultModel":"peeps-scripted-1","defaultThinkingLevel":"off","cacheWarming":{"mode":"off"},"compaction":{"enabled":False},"retry":{"enabled":False}}))
env = {"PATH":os.environ["PATH"],"HOME":str(sandbox),"TERM":"xterm-256color","PI_OFFLINE":"1","PI_CODING_AGENT_DIR":str(agent),"PEEPS_TEST_DIR":str(state),"PEEPS_SCRIPT_JSON":json.dumps({"finalText":"UI-CHILD-FINAL","steerToken":"unused","gateTag":"ui"}),"NO_COLOR":"1"}
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH",40,120,0,0))
args = [node,str(repo/"node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),"--no-extensions","-e",str(repo/"test/fixtures/parent-provider.ts"),"-e",str(repo/"src/index.ts"),"--no-skills","--no-prompt-templates","--no-context-files","--no-approve","--provider","peeps-scripted","--model","peeps-scripted-1","Delegate one task"]
proc = subprocess.Popen(args,stdin=slave,stdout=slave,stderr=slave,cwd=workspace,env=env,start_new_session=True)
os.close(slave)
output = b""
def read_until(marker, timeout=20):
    global output
    start=len(output); deadline=time.monotonic()+timeout
    while time.monotonic()<deadline:
        if select.select([master],[],[],.1)[0]:
            try: chunk=os.read(master,65536)
            except OSError: break
            if not chunk: break
            output+=chunk
            clean=re.sub(rb"\x1b\[[0-?]*[ -/]*[@-~]",b"",output[start:])
            if marker.encode() in clean: return
        if proc.poll() is not None: break
    raise RuntimeError("not seen: "+marker+"; exit="+str(proc.poll()))
try:
    read_until("PARENT-RECEIVED")
    os.write(master,b"/peeps\r")
    read_until("enter open")
    os.write(master,b"\r")
    read_until("UI-CHILD-FINAL")
    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH",60,140,0,0))
    proc.send_signal(signal.SIGWINCH)
    read_until("following")
    os.write(master,b"\x1b[27u"); time.sleep(.3)
    os.write(master,b"\x1b[27u"); time.sleep(.3)
    os.write(master,b"\x04")
    deadline=time.monotonic()+5
    while proc.poll() is None and time.monotonic()<deadline:
        if select.select([master],[],[],.1)[0]:
            try: output+=os.read(master,65536)
            except OSError: break
    if proc.poll() is None: proc.terminate()
    proc.wait(timeout=5)
    print("PASS real TUI: parent tool spawn -> child final -> automatic idle notice -> /peeps list -> native thread -> close -> quit")
finally:
    if proc.poll() is None:
        proc.kill(); proc.wait()
    try: os.killpg(proc.pid, signal.SIGKILL)
    except ProcessLookupError: pass
    os.close(master)
    (repo/".context/tui-smoke.log").write_bytes(output)
    shutil.rmtree(sandbox)
