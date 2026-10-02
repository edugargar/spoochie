/**
 * El aviso, como ventana nativa.
 *
 * Antes esto era `display dialog`, y el techo de `display dialog` es bajo: un solo
 * tamano de letra, un solo color, sin jerarquia. Quien llama, el asunto y lo que ha
 * dicho salian los tres iguales, asi que la primera lectura no distinguia el nombre de
 * la persona del texto de su pregunta. Se puede reordenar el texto todo lo que quieras;
 * mientras el pintor sea el mismo, se lee igual.
 *
 * Asi que el pintor cambia. Esto abre una NSWindow de verdad desde JXA (JavaScript for
 * Automation, que viene en todos los macOS: no hay que instalar nada ni compilar nada) y
 * coloca a mano cada pieza:
 *
 *   nombre       19 pt semibold, color de etiqueta
 *   asunto       13 pt, color secundario
 *   -----        linea de separacion del sistema
 *   la cita      13 pt con una regla de 2 pt del color de acento a la izquierda
 *   contexto     11 pt monoespaciada, color terciario (la rama es codigo, se lee como codigo)
 *   -----
 *   que pasa     11 pt, color terciario
 *   botones      "Ahora no", "Ver en Slack", "Que pase" (esta con el acento y el Return)
 *
 * El fondo es un NSVisualEffectView con material de popover, o sea el mismo cristal
 * translucido de los menus del sistema. La barra de titulo esta y no se ve: sin titulo,
 * sin los tres botones de semaforo, y la ventana se arrastra por cualquier sitio.
 *
 * La gracia no esta en el texto sino donde debe estar: el icono es Poochie y el boton
 * sigue siendo "Que pase". Un aviso que interrumpe tiene un segundo; la broma la pone
 * la cara, no un parrafo.
 *
 * NSAlert, PROBADO Y RECHAZADO. Es la caja del sistema y separa titular de cuerpo, que
 * era justo lo que faltaba. Medido: `alert.runModal` desde osascript devuelve 1000
 * (NSAlertFirstButtonReturn) al instante, sin esperar a nadie, porque el proceso de
 * osascript no tiene el bucle de eventos montado. O sea que la ventana parpadea y el
 * programa contesta "ha pulsado Que pase" sin que nadie haya pulsado nada. Un aviso que
 * se auto-acepta es peor que no tener aviso. `runModalForWindow` sobre una ventana
 * propia si bloquea, que es por lo que la ventana se monta a mano.
 */
import * as T from "./threads.ts";
import { envVar } from "./paths.ts";

/** El ancho fijo. Una columna estrecha se lee de un vistazo; una ancha obliga a barrer
 *  la linea entera, y esto se mira durante un segundo. */
export const WIDTH = 440;
const MARGEN = 26;

/** Lo que se ve en el aviso, ya en piezas. Lo comparten la ventana, el DM de Slack y el
 *  primer turno del aparte, para que los tres digan lo mismo. */
export type Parts = { quien: string; asunto: string; contexto: string; cita: string; pie: string };

/** La cita se recorta por frases, no por caracteres: cortar a mitad de palabra y pegar
 *  "[...]" es lo que hace que un aviso parezca un log y no un mensaje. */
const MAX_CITA = 280;

export function clip(texto: string): string {
  const limpio = texto.trim().replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n");
  if (limpio.length <= MAX_CITA) return limpio;
  const corte = limpio.slice(0, MAX_CITA);
  const fin = Math.max(corte.lastIndexOf(". "), corte.lastIndexOf("? "), corte.lastIndexOf("! "));
  return (fin > MAX_CITA / 2 ? corte.slice(0, fin + 1) : corte.replace(/\s+\S*$/, "")) + " …";
}

export function parts(t: T.Thread): Parts {
  const asunto = t.subject.trim();
  return {
    quien: `${t.from.human ?? t.from.name} llama.`,
    asunto: asunto.charAt(0).toUpperCase() + asunto.slice(1),
    // Solo lo que exista de verdad: una etiqueta vacia ("Rama: -") es peor que no ponerla.
    contexto: [
      t.context.branch,
      t.context.files?.length ? `${t.context.files.length} ${t.context.files.length === 1 ? "fichero" : "ficheros"}` : null,
    ].filter(Boolean).join(" · "),
    cita: clip(t.messages[0]?.text ?? ""),
    pie: "Le contesta un Claude de solo lectura, en una ventana aparte.\nTus sesiones no se enteran.",
  };
}

export const BUTTONS = { rechazar: "Ahora no", slack: "Ver en Slack", aceptar: "Que pase" };

/**
 * Donde se planta la ventana, en puntos y contando desde arriba a la izquierda.
 *
 * Existe por el script de capturas. Capturar una ventana por su id exige el permiso de
 * Accesibilidad de macOS, y sin el la unica salida era `screencapture` de la pantalla
 * entera: medido, el primer intento se llevo el escritorio de quien lo corria. Si la
 * ventana se puede plantar en un sitio conocido, `screencapture -R` recorta ese
 * rectangulo exacto y dentro del PNG no hay nada mas.
 *
 * Sin la variable, centrada, que es donde tiene que estar cuando la mira una persona.
 */
export function requestedPosition(): { x: number; y: number } | null {
  const v = envVar("SPOOCHIE_WINDOW_POS", "SPOOCHIE_VENTANA_POS");
  if (!v) return null;
  const [x, y] = v.split(",").map(n => Number(n.trim()));
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
}

/**
 * Pulsar un boton solo, sin que se vea. Existe para la prueba de punta a punta.
 *
 * La ventana se probaba con capturas y mirando el guion, nunca pulsando, y por eso el
 * clic llego vacio a produccion (ver `button returned` abajo). Probarla pulsando con la
 * ventana visible parpadea sobre el trabajo de quien corre los tests, asi que con esta
 * variable la ventana sale transparente, sin icono en el Dock y sin tomar el foco, y un
 * temporizador pulsa el boton con ese numero (1 rechazar, 2 Slack, 3 aceptar). Todo lo
 * demas es la ventana de verdad: el mismo NSWindow, la misma accion, el mismo modal y la
 * misma salida. Solo la lee el proceso que genera el guion, o sea el demonio de quien lo
 * corre; nada que llegue por el tunel puede ponerla.
 */
export function requestedClick(): 1 | 2 | 3 | 0 {
  const v = envVar("SPOOCHIE_WINDOW_CLICK", "SPOOCHIE_VENTANA_CLIC");
  return v === "1" ? 1 : v === "2" ? 2 : v === "3" ? 3 : 0;
}

/**
 * El programa JXA.
 *
 * Los datos van en un literal JSON al principio en vez de interpolados por el cuerpo:
 * asi el texto de otra persona nunca es codigo, solo el contenido de una variable. Es la
 * misma razon por la que existe el portero.
 */
export function windowScript(t: T.Thread, icono: string | null): string {
  const d = {
    ...parts(t),
    icono: icono ?? "",
    pos: requestedPosition(),
    clic: requestedClick(),
    botones: [
      { titulo: BUTTONS.rechazar, tag: 1, tecla: "" },
      { titulo: BUTTONS.slack, tag: 2, tecla: "" },
      { titulo: BUTTONS.aceptar, tag: 3, tecla: "\r" },
    ],
    ancho: WIDTH,
    margen: MARGEN,
  };
  // U+2028 y U+2029 son legales dentro de una cadena JSON y rompen un literal de
  // JavaScript. Salen escapados y el JSON sigue siendo el mismo JSON.
  const datos = JSON.stringify(d).split("\u2028").join("\\u2028").split("\u2029").join("\\u2029");
  return `ObjC.import('Cocoa');
var D = ${datos};
var app = $.NSApplication.sharedApplication;
// 1 = accesorio: sin icono en el Dock y sin tomar el foco. Solo en la prueba (D.clic).
app.setActivationPolicy(D.clic ? 1 : 0);

// El destino de los botones. Cada uno lleva su tag y para el modal con ese numero.
ObjC.registerSubclass({
  name: 'SpDestino', superclass: 'NSObject',
  methods: { 'pulsa:': { types: ['void', ['id']], implementation: function (b) {
    $.NSApplication.sharedApplication.stopModalWithCode(b.tag);
  } } }
});
var destino = $.SpDestino.alloc.init;

var W = D.ancho, PAD = D.margen, COL = W - PAD * 2;
function texto(s, font, color, ancho) {
  var t = $.NSTextField.alloc.initWithFrame($.NSMakeRect(0, 0, ancho, 20));
  t.stringValue = s; t.editable = false; t.selectable = true; t.bezeled = false;
  t.drawsBackground = false; t.font = font; t.textColor = color;
  t.lineBreakMode = $.NSLineBreakByWordWrapping; t.usesSingleLineMode = false; t.cell.wraps = true;
  t.setFrameSize($.NSMakeSize(ancho, t.cell.cellSizeForBounds($.NSMakeRect(0, 0, ancho, 10000)).height));
  return t;
}
var F = {
  quien: $.NSFont.systemFontOfSizeWeight(19, $.NSFontWeightSemibold),
  asunto: $.NSFont.systemFontOfSize(13),
  cita: $.NSFont.systemFontOfSize(13),
  meta: $.NSFont.monospacedSystemFontOfSizeWeight(11, $.NSFontWeightRegular),
  pie: $.NSFont.systemFontOfSize(11),
};
// El icono le come sitio a las dos primeras lineas y a ninguna mas.
var HUECO = D.icono ? 56 : 0;
var filas = [];
filas.push({ tipo: 'texto', vista: texto(D.quien, F.quien, $.NSColor.labelColor, COL - HUECO), hueco: 5 });
filas.push({ tipo: 'texto', vista: texto(D.asunto, F.asunto, $.NSColor.secondaryLabelColor, COL - HUECO), hueco: 18 });
filas.push({ tipo: 'linea', hueco: 16 });
filas.push({ tipo: 'cita', vista: texto(D.cita ? '“' + D.cita + '”' : '', F.cita, $.NSColor.labelColor, COL - 16), hueco: D.contexto ? 10 : 16 });
if (D.contexto) filas.push({ tipo: 'texto', vista: texto(D.contexto, F.meta, $.NSColor.tertiaryLabelColor, COL), hueco: 16 });
filas.push({ tipo: 'linea', hueco: 13 });
filas.push({ tipo: 'texto', vista: texto(D.pie, F.pie, $.NSColor.tertiaryLabelColor, COL), hueco: 20 });

var alto = PAD * 2 + 28;
for (var i = 0; i < filas.length; i++) alto += (filas[i].vista ? filas[i].vista.frame.size.height : 1) + filas[i].hueco;

// Titled + FullSizeContentView: hace falta el titulo para que la ventana tenga esquinas
// redondeadas y sombra, y FullSizeContentView para que el cristal llegue hasta arriba.
// Sin el segundo queda una banda opaca donde iria la barra de titulo, medida en la
// primera captura: 28 pt de gris plano encima del contenido.
var win = $.NSWindow.alloc.initWithContentRectStyleMaskBackingDefer(
  $.NSMakeRect(0, 0, W, alto), (1 << 0) | (1 << 15), 2, false);
win.titlebarAppearsTransparent = true;
win.titleVisibility = 1;             // NSWindowTitleHidden
win.movableByWindowBackground = true;
win.level = $.NSFloatingWindowLevel; // por encima del editor, que es de donde viene la persona
for (var b = 0; b < 3; b++) { var sem = win.standardWindowButton(b); if (!sem.isNil()) sem.hidden = true; }

var fondo = $.NSVisualEffectView.alloc.initWithFrame($.NSMakeRect(0, 0, W, alto));
fondo.material = $.NSVisualEffectMaterialPopover;
fondo.blendingMode = $.NSVisualEffectBlendingModeBehindWindow;
fondo.state = $.NSVisualEffectStateActive;
win.contentView = fondo;

var y = alto - PAD;
for (var i = 0; i < filas.length; i++) {
  var f = filas[i];
  if (f.tipo === 'linea') {
    var l = $.NSBox.alloc.initWithFrame($.NSMakeRect(PAD, y - 1, COL, 1));
    l.boxType = $.NSBoxCustom; l.borderWidth = 1; l.borderColor = $.NSColor.separatorColor;
    fondo.addSubview(l);
    y -= 1 + f.hueco;
    continue;
  }
  var h = f.vista.frame.size.height;
  var x = PAD;
  if (f.tipo === 'cita') {
    var regla = $.NSBox.alloc.initWithFrame($.NSMakeRect(PAD, y - h, 2, h));
    regla.boxType = $.NSBoxCustom; regla.borderWidth = 0;
    regla.fillColor = $.NSColor.controlAccentColor;
    fondo.addSubview(regla);
    x = PAD + 16;
  }
  f.vista.setFrameOrigin($.NSMakePoint(x, y - h));
  fondo.addSubview(f.vista);
  y -= h + f.hueco;
}

if (D.icono) {
  var img = $.NSImage.alloc.initWithContentsOfFile(D.icono);
  if (!img.isNil()) {
    var iv = $.NSImageView.alloc.initWithFrame($.NSMakeRect(W - PAD - 44, alto - PAD - 46, 44, 44));
    iv.image = img; iv.imageScaling = $.NSImageScaleProportionallyUpOrDown;
    fondo.addSubview(iv);
  }
}

var x2 = W - PAD;
var BTS = {};
for (var i = D.botones.length - 1; i >= 0; i--) {
  var d = D.botones[i];
  var bt = $.NSButton.alloc.initWithFrame($.NSMakeRect(0, 0, 90, 28));
  bt.title = d.titulo; bt.bezelStyle = $.NSBezelStyleRounded; bt.tag = d.tag;
  bt.target = destino; bt.action = $.NSSelectorFromString('pulsa:'); BTS[d.tag] = bt;
  if (d.tecla) bt.keyEquivalent = d.tecla;
  bt.sizeToFit;
  var w2 = Math.max(bt.frame.size.width + 22, 82);
  bt.setFrameSize($.NSMakeSize(w2, 28));
  bt.setFrameOrigin($.NSMakePoint(x2 - w2, PAD - 8));
  x2 -= w2 + 8;
  fondo.addSubview(bt);
}

if (D.pos) {
  // La variable llega contando desde arriba; Cocoa cuenta desde abajo.
  var p = $.NSScreen.mainScreen.frame;
  win.setFrameOrigin($.NSMakePoint(D.pos.x, p.size.height - D.pos.y - alto));
} else {
  win.center;
}
if (D.clic) {
  win.alphaValue = 0; win.ignoresMouseEvents = true;
  ObjC.registerSubclass({ name: 'SpClic', superclass: 'NSObject', methods: { 'tick:': { types: ['void', ['id']], implementation: function (x) { BTS[D.clic].performClick(null); } } } });
  var tm = $.NSTimer.timerWithTimeIntervalTargetSelectorUserInfoRepeats(0.6, $.SpClic.alloc.init, 'tick:', null, false);
  $.NSRunLoop.currentRunLoop.addTimerForMode(tm, $.NSRunLoopCommonModes);
} else {
  app.activateIgnoringOtherApps(true);
}
win.makeKeyAndOrderFront(null);
// El alto sale calculado del texto, asi que solo se sabe aqui. Se dice en voz alta para
// que el script de capturas recorte el rectangulo exacto de la ventana y nada mas.
console.log("alto:" + alto);
var r = app.runModalForWindow(win);
var nombre = "";
// runModalForWindow devuelve el codigo como CADENA ("3"), no como numero: con === ningun
// boton casaba y salia "button returned:" vacio. Medido pulsando los tres.
for (var i = 0; i < D.botones.length; i++) if (D.botones[i].tag === Number(r)) nombre = D.botones[i].titulo;
console.log("button returned:" + nombre);
`;
}
