/**
 * The notice, as a native window.
 *
 * This used to be `display dialog`, and `display dialog` has a low ceiling: one font
 * size, one color, no hierarchy. Who is calling, the subject and what they said all
 * came out the same, so on first read you could not tell the person's name from the
 * text of their question. You can reorder the text as much as you like; while the
 * painter stays the same, it reads the same.
 *
 * So the painter changes. This opens a real NSWindow from JXA (JavaScript for
 * Automation, which ships with every macOS: nothing to install, nothing to compile) and
 * places each piece by hand:
 *
 *   name         19 pt semibold, label color
 *   subject      13 pt, secondary color
 *   -----        system separator line
 *   the quote    13 pt with a 2 pt rule in the accent color on its left
 *   context      11 pt monospaced, tertiary color (the branch is code, it reads as code)
 *   -----
 *   what happens 11 pt, tertiary color
 *   buttons      "Not now", "Open in Slack", "Let it in" (this one has the accent and Return)
 *
 * The background is an NSVisualEffectView with the popover material, the same
 * translucent glass as the system menus. The title bar is there but hidden: no title,
 * no traffic-light buttons, and the window drags from anywhere.
 *
 * The joke is not in the text but where it belongs: the icon is the dog and the button
 * still says "Let it in". A notice that interrupts gets one second; the face carries the
 * joke, not a paragraph.
 *
 * NSAlert, TRIED AND REJECTED. It is the system box and it separates headline from
 * body, which was exactly what was missing. Measured: `alert.runModal` from osascript
 * returns 1000 (NSAlertFirstButtonReturn) at once, without waiting for anyone, because
 * the osascript process has no event loop running. So the window flickers and the
 * program answers "they pressed Let it in" without anyone pressing anything. A notice
 * that accepts itself is worse than no notice. `runModalForWindow` on a window of our
 * own does block, which is why the window is built by hand.
 */
import * as T from "./threads.ts";
import { envVar } from "./paths.ts";

/** Fixed width. A narrow column reads at a glance; a wide one makes you sweep the
 *  whole line, and this gets looked at for one second. */
export const WIDTH = 440;
const MARGIN = 26;

/** What the notice shows, already in pieces. The window, the Slack DM and the aside's
 *  first turn share it, so the three say the same thing. */
export type Parts = { quien: string; asunto: string; contexto: string; cita: string; pie: string };

/** The quote is trimmed by sentences, not by characters: cutting mid-word and pasting
 *  "[...]" is what makes a notice look like a log instead of a message. */
const MAX_QUOTE = 280;

export function clip(text: string): string {
  const clean = text.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  if (clean.length <= MAX_QUOTE) return clean;
  const cut = clean.slice(0, MAX_QUOTE);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return (end > MAX_QUOTE / 2 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "")) + " …";
}

export function parts(t: T.Thread): Parts {
  const subject = t.subject.trim();
  return {
    quien: `${t.from.human ?? t.from.name} is calling.`,
    asunto: subject.charAt(0).toUpperCase() + subject.slice(1),
    // Only what really exists: an empty label ("Branch: -") is worse than none.
    contexto: [
      t.context.branch,
      t.context.files?.length ? `${t.context.files.length} ${t.context.files.length === 1 ? "file" : "files"}` : null,
    ].filter(Boolean).join(" · "),
    cita: clip(t.messages[0]?.text ?? ""),
    pie: "A read-only Claude answers, in a separate window.\nYour own sessions never see it.",
  };
}

export const BUTTONS = { decline: "Not now", slack: "Open in Slack", accept: "Let it in" };

/**
 * Where the window goes, in points, counting from the top left.
 *
 * It exists for the screenshots script. Capturing a window by its id needs the macOS
 * Accessibility permission, and without it the only way out was `screencapture` of the
 * whole screen: measured, the first attempt grabbed the desktop of whoever ran it. If
 * the window can be placed somewhere known, `screencapture -R` crops that exact
 * rectangle and the PNG holds nothing else.
 *
 * Without the variable, centered, which is where it belongs when a person looks at it.
 */
export function requestedPosition(): { x: number; y: number } | null {
  const v = envVar("SPOOCHIE_WINDOW_POS", "SPOOCHIE_VENTANA_POS");
  if (!v) return null;
  const [x, y] = v.split(",").map(n => Number(n.trim()));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Press a button by itself, out of sight. It exists for the end-to-end test.
 *
 * The window was tested with screenshots and by reading the script, never by clicking,
 * and that is how the click reached production empty (see `button returned` below).
 * Testing it by clicking with the window visible flickers over the work of whoever runs
 * the tests, so with this variable the window comes out transparent, with no Dock icon
 * and without taking focus, and a timer presses the button with that number (1 decline,
 * 2 Slack, 3 accept). Everything else is the real window: the same NSWindow, the same
 * action, the same modal and the same output. Only the process that generates the
 * script reads it, that is the daemon of whoever runs it; nothing arriving through the
 * tunnel can set it.
 */
export function requestedClick(): 1 | 2 | 3 | 0 {
  const v = envVar("SPOOCHIE_WINDOW_CLICK", "SPOOCHIE_VENTANA_CLIC");
  return v === "1" ? 1 : v === "2" ? 2 : v === "3" ? 3 : 0;
}

/**
 * The JXA program.
 *
 * The data goes in a JSON literal at the top instead of being interpolated through the
 * body: that way another person's text is never code, only the content of a variable.
 * It is the same reason the gatekeeper exists.
 */
export function windowScript(t: T.Thread, icon: string | null): string {
  const d = {
    ...parts(t),
    icon: icon ?? "",
    pos: requestedPosition(),
    click: requestedClick(),
    buttons: [
      { title: BUTTONS.decline, tag: 1, key: "" },
      { title: BUTTONS.slack, tag: 2, key: "" },
      { title: BUTTONS.accept, tag: 3, key: "\r" },
    ],
    width: WIDTH,
    margin: MARGIN,
  };
  // U+2028 and U+2029 are legal inside a JSON string and break a JavaScript literal.
  // They go out escaped and the JSON is still the same JSON.
  const data = JSON.stringify(d).split("\u2028").join("\\u2028").split("\u2029").join("\\u2029");
  return `ObjC.import('Cocoa');
var D = ${data};
var app = $.NSApplication.sharedApplication;
// 1 = accessory: no Dock icon and no focus. Only in the test (D.click).
app.setActivationPolicy(D.click ? 1 : 0);

// The buttons' target. Each carries its tag and stops the modal with that number.
ObjC.registerSubclass({
  name: 'SpTarget', superclass: 'NSObject',
  methods: { 'press:': { types: ['void', ['id']], implementation: function (b) {
    $.NSApplication.sharedApplication.stopModalWithCode(b.tag);
  } } }
});
var target = $.SpTarget.alloc.init;

var W = D.width, PAD = D.margin, COL = W - PAD * 2;
function label(s, font, color, width) {
  var t = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, width, 20));
  t.stringValue = s; t.editable = false; t.selectable = true; t.bezeled = false;
  t.drawsBackground = false; t.font = font; t.textColor = color;
  t.lineBreakMode = $.NSLineBreakByWordWrapping; t.usesSingleLineMode = false; t.cell.wraps = true;
  t.setFrameSize($.NSMakeSize(width, t.cell.cellSizeForBounds($.NSMakeRect(0, 0, width, 10000)).height));
  return t;
}
var F = {
  who: $.NSFont.systemFontOfSizeWeight(19, $.NSFontWeightSemibold),
  subject: $.NSFont.systemFontOfSize(13),
  quote: $.NSFont.systemFontOfSize(13),
  meta: $.NSFont.monospacedSystemFontOfSizeWeight(11, $.NSFontWeightRegular),
  footer: $.NSFont.systemFontOfSize(11),
};
// The icon takes room from the first two lines and no others.
var GAP = D.icon ? 56 : 0;
var rows = [];
rows.push({ kind: 'text', view: label(D.quien, F.who, $.NSColor.labelColor, COL - GAP), space: 5 });
rows.push({ kind: 'text', view: label(D.asunto, F.subject, $.NSColor.secondaryLabelColor, COL - GAP), space: 18 });
rows.push({ kind: 'line', space: 16 });
rows.push({ kind: 'quote', view: label(D.cita ? '“' + D.cita + '”' : '', F.quote, $.NSColor.labelColor, COL - 16), space: D.contexto ? 10 : 16 });
if (D.contexto) rows.push({ kind: 'text', view: label(D.contexto, F.meta, $.NSColor.tertiaryLabelColor, COL), space: 16 });
rows.push({ kind: 'line', space: 13 });
rows.push({ kind: 'text', view: label(D.pie, F.footer, $.NSColor.tertiaryLabelColor, COL), space: 20 });

var height = PAD * 2 + 28;
for (var i = 0; i < rows.length; i++) height += (rows[i].view ? rows[i].view.frame.size.height : 1) + rows[i].space;

// Titled + FullSizeContentView: the title is needed for the window to get rounded
// corners and a shadow, and FullSizeContentView for the glass to reach the top.
// Without the second there is an opaque band where the title bar would be, measured in
// the first screenshot: 28 pt of flat gray above the content.
var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  $.NSMakeRect(0, 0, W, height), (1 << 0) | (1 << 15), 2, false);
win.titlebarAppearsTransparent = true;
win.titleVisibility = 1;             // NSWindowTitleHidden
win.movableByWindowBackground = true;
win.level = $.NSFloatingWindowLevel; // above the editor, which is where the person comes from
for (var b = 0; b < 3; b++) { var light = win.standardWindowButton(b); if (!light.isNil()) light.hidden = true; }

var bg = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, height));
bg.material = $.NSVisualEffectMaterialPopover;
bg.blendingMode = $.NSVisualEffectBlendingModeBehindWindow;
bg.state = $.NSVisualEffectStateActive;
win.contentView = bg;

var y = height - PAD;
for (var i = 0; i < rows.length; i++) {
  var f = rows[i];
  if (f.kind === 'line') {
    var l = $.NSBox.alloc.initWithFrame($.NSMakeRect(PAD, y - 1, COL, 1));
    l.boxType = $.NSBoxCustom; l.borderWidth = 1; l.borderColor = $.NSColor.separatorColor;
    bg.addSubview(l);
    y -= 1 + f.space;
    continue;
  }
  var h = f.view.frame.size.height;
  var x = PAD;
  if (f.kind === 'quote') {
    var rule = $.NSBox.alloc.initWithFrame($.NSMakeRect(PAD, y - h, 2, h));
    rule.boxType = $.NSBoxCustom; rule.borderWidth = 0;
    rule.fillColor = $.NSColor.controlAccentColor;
    bg.addSubview(rule);
    x = PAD + 16;
  }
  f.view.setFrameOrigin($.NSMakePoint(x, y - h));
  bg.addSubview(f.view);
  y -= h + f.space;
}

if (D.icon) {
  var img = $.NSImage.alloc.initWithContentsOfFile(D.icon);
  if (!img.isNil()) {
    var iv = $.NSImageView.alloc.initWithFrame($.NSMakeRect(W - PAD - 44, height - PAD - 46, 44, 44));
    iv.image = img; iv.imageScaling = $.NSImageScaleProportionallyUpOrDown;
    bg.addSubview(iv);
  }
}

var x2 = W - PAD;
var BTS = {};
for (var i = D.buttons.length - 1; i >= 0; i--) {
  var d = D.buttons[i];
  var bt = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, 90, 28));
  bt.title = d.title; bt.bezelStyle = $.NSBezelStyleRounded; bt.tag = d.tag;
  bt.target = target; bt.action = $.NSSelectorFromString('press:'); BTS[d.tag] = bt;
  if (d.key) bt.keyEquivalent = d.key;
  bt.sizeToFit;
  var w2 = Math.max(bt.frame.size.width + 22, 82);
  bt.setFrameSize($.NSMakeSize(w2, 28));
  bt.setFrameOrigin($.NSMakePoint(x2 - w2, PAD - 8));
  x2 -= w2 + 8;
  bg.addSubview(bt);
}

if (D.pos) {
  // The variable counts from the top; Cocoa counts from the bottom.
  var p = $.NSScreen.mainScreen.frame;
  win.setFrameOrigin($.NSMakePoint(D.pos.x, p.size.height - D.pos.y - height));
} else {
  win.center;
}
if (D.click) {
  win.alphaValue = 0; win.ignoresMouseEvents = true;
  ObjC.registerSubclass({ name: 'SpClick', superclass: 'NSObject', methods: { 'tick:': { types: ['void', ['id']], implementation: function (x) { BTS[D.click].performClick(null); } } } });
  var tm = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.6, $.SpClick.alloc.init, 'tick:', null, false);
  $.NSRunLoop.currentRunLoop.addTimerForMode(tm, $.NSRunLoopCommonModes);
} else {
  app.activateIgnoringOtherApps(true);
}
win.makeKeyAndOrderFront(null);
// The height comes from the text, so it is only known here. It is printed so the
// screenshots script crops the window's exact rectangle and nothing else.
console.log("height:" + height);
var r = app.runModalForWindow(win);
var pressed = "";
// runModalForWindow returns the code as a STRING ("3"), not a number: with === no
// button matched and "button returned:" came out empty. Measured by pressing all three.
for (var i = 0; i < D.buttons.length; i++) if (D.buttons[i].tag === Number(r)) pressed = D.buttons[i].title;
console.log("button returned:" + pressed);
`;
}
