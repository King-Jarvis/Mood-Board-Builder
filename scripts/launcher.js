// Mood Board Builder launcher (JXA — JavaScript for Automation).
//
// Click it and the board opens. If the server is already up it just opens the
// browser; otherwise it starts the server, waits for it to answer, and opens
// the browser. No Terminal window is left behind.
//
// The server is started with NSTask, NOT `do shell script`. An AppleScript
// version of this hung: `do shell script` waits on the spawned Python process
// even when it is backgrounded and its output redirected, so the launcher
// never reached the "open the browser" step. NSTask.launch returns as soon as
// the child is running, and the child reparents to launchd when we exit.

ObjC.import('Foundation');

var app = Application.currentApplication();
app.includeStandardAdditions = true;

// Where the repo is checked out, relative to your home folder.
var REPO_REL = 'Documents/Claude Code/Mood-Board-Builder';
var PORT = 8765;
var OUT_LOG = '/tmp/house-mood-board.out';

var HOME = ObjC.unwrap($.NSHomeDirectory());
var DIR = HOME + '/' + REPO_REL;
var TRACE = DIR + '/launcher.log';

// -- helpers ----------------------------------------------------------------

function stamp() {
  return ObjC.unwrap($.NSDate.date.description).slice(11, 19);
}

/** Progress log. The reason the AppleScript hang went unnoticed was that it
 *  left no trace of how far it got; this file makes that visible. */
function trace(msg) {
  try {
    var line = stamp() + '  ' + msg + '\n';
    var fm = $.NSFileManager.defaultManager;
    if (!fm.fileExistsAtPath(TRACE)) {
      $(line).writeToFileAtomicallyEncodingError(TRACE, true, $.NSUTF8StringEncoding, null);
    } else {
      var fh = $.NSFileHandle.fileHandleForWritingAtPath(TRACE);
      fh.seekToEndOfFile;
      fh.writeData($(line).dataUsingEncoding($.NSUTF8StringEncoding));
      fh.closeFile;
    }
  } catch (e) { /* never let logging break the launch */ }
}

function sh(cmd) {
  // Only ever used for commands that exit on their own (curl, tail, open).
  return app.doShellScript(cmd);
}

function fileExists(path) {
  return $.NSFileManager.defaultManager.fileExistsAtPath(path);
}

/** Confirm what's listening is OUR server, not another process on the port. */
function isOurs(port) {
  try {
    var reply = sh("/usr/bin/curl -s -m 2 http://127.0.0.1:" + port + "/api/boards");
    return reply.indexOf('boards') !== -1;
  } catch (e) {
    return false;
  }
}

/** The server auto-increments if the port is taken and logs where it landed. */
function portFromLog() {
  try {
    var found = sh(
      "/usr/bin/tail -n 40 " + JSON.stringify(DIR + '/launcher.log') +
      " | /usr/bin/grep -o 'http://127\\.0\\.0\\.1:[0-9]*/'" +
      " | /usr/bin/tail -n 1 | /usr/bin/sed 's/[^0-9]*//;s|/||'");
    var n = parseInt(found, 10);
    return isNaN(n) ? 0 : n;
  } catch (e) {
    return 0;
  }
}

function openBoard(port) {
  var url = 'http://127.0.0.1:' + port + '/';
  sh('/usr/bin/open ' + JSON.stringify(url));
  trace('opened browser at ' + url);
}

function fail(msg) {
  trace('FAILED: ' + msg);
  var tail = '';
  try { tail = sh('/usr/bin/tail -n 6 ' + JSON.stringify(DIR + '/launcher.log')); } catch (e) {}
  app.displayAlert('Mood Board Builder couldn’t start', {
    message: msg + '\n\n' + tail,
    as: 'critical',
    buttons: ['OK'],
    defaultButton: 'OK',
  });
}

/** Start the server detached. Returns immediately. */
function startServer() {
  var fm = $.NSFileManager.defaultManager;
  if (!fm.fileExistsAtPath(OUT_LOG)) {
    fm.createFileAtPathContentsAttributes(OUT_LOG, $(), $());
  }
  var fh = $.NSFileHandle.fileHandleForWritingAtPath(OUT_LOG);
  fh.seekToEndOfFile;

  var task = $.NSTask.alloc.init;
  task.launchPath = '/usr/bin/python3';
  task.arguments = ['-u', '-m', 'moodboards', '--port', String(PORT)];
  task.currentDirectoryPath = DIR;
  task.standardOutput = fh;
  task.standardError = fh;
  task.standardInput = $.NSFileHandle.fileHandleWithNullDevice;
  task.launch;
  trace('launched python3 (pid ' + task.processIdentifier + ')');
}

// -- main -------------------------------------------------------------------

function run() {
  trace('--- launch ---');

  if (!fileExists(DIR + '/moodboards/__main__.py')) {
    fail('The repo isn’t at ' + DIR + '.');
    return;
  }

  if (isOurs(PORT)) {
    trace('already running on ' + PORT);
    openBoard(PORT);
    return;
  }

  var logged = portFromLog();
  if (logged > 0 && logged !== PORT && isOurs(logged)) {
    trace('already running on ' + logged);
    openBoard(logged);
    return;
  }

  trace('not running — starting');
  try {
    startServer();
  } catch (e) {
    fail('Could not start Python: ' + e.message);
    return;
  }

  // Startup is well under a second; allow generously for a cold interpreter.
  for (var i = 0; i < 30; i++) {
    delay(0.4);
    if (isOurs(PORT)) {
      trace('answered on ' + PORT + ' after ' + ((i + 1) * 0.4).toFixed(1) + 's');
      openBoard(PORT);
      return;
    }
    var p = portFromLog();
    if (p > 0 && p !== PORT && isOurs(p)) {
      trace('answered on ' + p);
      openBoard(p);
      return;
    }
  }

  fail('The server didn’t answer on port ' + PORT + ' within 12 seconds.');
}
