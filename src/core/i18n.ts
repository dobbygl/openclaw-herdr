/**
 * Human-facing text of the plugin, in the languages it ships.
 *
 * OpenClaw gives plugins no trusted conversation or user language (see
 * docs/adr/0005), so the language is an explicit plugin setting and is never
 * guessed. Only the plugin's own sentences are translated. Everything passed
 * in as an argument stays verbatim: pane ids, agent names, tab labels, paths,
 * machine labels, Herdr's own error messages and agent output. Command syntax
 * (`/herdr read <target> [lines 1-400]`) is the same in every language,
 * placeholders included, because it is what the operator types.
 *
 * Model-facing text (tool descriptions, agent guidance, the relay header of a
 * watch event) and logs stay English on purpose.
 */

export const LANGUAGES = ["en", "es"] as const;
export type Language = (typeof LANGUAGES)[number];
export const DEFAULT_LANGUAGE: Language = "en";

export function isLanguage(value: unknown): value is Language {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value);
}

/** Why `parseTargetRef` refused a target; the runtime words it. */
export type TargetSyntaxProblem =
  | { kind: "empty"; target: string }
  | { kind: "empty_selector"; target: string }
  | { kind: "selector_at"; target: string }
  | { kind: "bad_server"; target: string; server: string };

/** Why `ServerRegistry.resolve` refused a `@server`; the runtime words it. */
export type ServerProblem =
  | { kind: "ambiguous_label"; server: string; ids: string[] }
  | { kind: "unknown"; server: string; known: string[]; catalogError?: string; remoteDisabled?: boolean };

/** Resolution levels of `resolveTarget`, most specific first. */
export type TargetLevel = "pane_id" | "terminal_id" | "agent_name" | "tab_label" | "agent_kind";

/** The settled states a watch notification can report. */
export type NotificationKind = "blocked" | "exited" | "occupant_changed" | "timed_out" | "finished";

const EN = {
  // ---- agent lists and status ----
  noAgentKind: "no agent",
  noRunningAgent: "Herdr sees no running coding agent. Start claude or codex inside a Herdr pane.",
  agentsHeader: "Herdr agents:",
  noAgentOnHost: "no agent on this host",
  noAgentThere: "no agent there",
  machineHeader: (label: string) => `Machine ${label}:`,
  machineDown: (label: string, reason: string) => `Machine ${label}: down — ${reason}`,
  machineListUnavailable: (reason: string) => `Machine list unavailable: ${reason}`,
  watchingMark: "watching",
  watchingSince: (timestamp: string) => `watching since ${timestamp}`,
  cannotReachHerdr: (reason: string) => `Cannot reach Herdr: ${reason}. Is the Herdr server running?`,
  cannotReachMachine: (label: string, reason: string) => `I cannot reach ${label}: ${reason}.`,
  onMachine: (label: string, message: string) => `On ${label}: ${message}`,

  // ---- sending ----
  sentTo: (ref: string, label: string) => `Sent to **${ref}** (${label}).`,
  trackingWatching: "I will tell you when it finishes or needs input.",
  trackingOff: "Not watching; use /herdr status to check.",
  trackingFailed:
    "It was delivered, but I could not set up the watch, so I will not be able to tell you when it finishes; use /herdr status.",
  blockedNotSent: (ref: string) => `${ref} is waiting for input, so I did not send anything.`,
  blockedAnswerInTerminal:
    "Read the prompt below and answer it in the terminal (Herdr or Collie); answering from chat is not implemented yet.",
  sendUnconfirmed: (ref: string, reason: string) => `I could not confirm the send to **${ref}**: ${reason}.`,
  sendMaybeDeliveredWatching:
    "The prompt may have been delivered; I am still watching, so check /herdr status before resending.",
  sendMaybeDelivered: "The prompt may have been delivered; check /herdr status before resending.",
  nothingSent: (ref: string, why: string) => `Nothing was sent to ${ref}. ${why}`,
  readOnly: (ref: string, label: string) => [
    `I did not send anything to **${ref}**: ${label} is read-only.`,
    `Add "${label}" to remote.allowSend in the plugin config to allow prompts there.`,
  ],
  readEmpty: (ref: string) => `${ref} shows nothing yet.`,

  // ---- watching ----
  watchNeedsSession: "Watching needs an OpenClaw session to report back to.",
  watchFailed: (ref: string, reason: string) => `I am not watching ${ref}: ${reason}. Try again once it answers.`,
  watchStarted: (ref: string, status: string) =>
    `Watching ${ref} (${status}). I will tell you when it finishes or blocks.`,
  currentTask: "(current task)",
  agentFallback: "agent",
  watcherNotRunning: "Watcher is not running.",
  unwatchedCount: (ref: string, count: number) =>
    `Stopped watching ${ref} (${count} watch${count === 1 ? "" : "es"}).`,
  unwatched: (ref: string) => `Stopped watching ${ref}.`,
  notWatched: (ref: string) => `${ref} was not being watched.`,
  watchedElsewhere: (ref: string) => `${ref} is watched by another chat, not by this one.`,

  // ---- notifications ----
  notification: (kind: NotificationKind, who: string): string => {
    switch (kind) {
      case "blocked":
        return `Herdr: ${who} needs your input.`;
      case "exited":
        return `Herdr: ${who} exited.`;
      case "occupant_changed":
        return `Herdr: ${who} is gone; that pane runs something else now, so I stopped watching it.`;
      case "timed_out":
        return `Herdr: ${who} is still not finished after the watch deadline.`;
      case "finished":
        return `Herdr: ${who} finished.`;
    }
  },
  blockedAnswerHint: "Answer it in the terminal (Herdr or Collie): I cannot answer a prompt for you while the agent is blocked.",
  blockedReadHint: (ref: string) =>
    `/herdr read ${ref} shows the prompt again. Answering from chat is not implemented yet.`,

  // ---- starting agents ----
  startNameTaken: (ref: string, kind: string, pane: string) =>
    `${ref} already runs ${kind} in **${pane}**; pick another name.`,
  startNoPane: (ref: string) => `There is no pane ${ref}.`,
  startPaneBusy: (ref: string, kind: string) => `${ref} already runs ${kind}; Herdr needs an idle shell pane.`,
  started: (name: string, kind: string, ref: string, created: boolean) =>
    `Started **${name}** (${kind}) in **${ref}**${created ? " (new pane)" : ""}.`,
  startSendHint: (target: string) => `Send work with /herdr ${target}: <prompt>.`,
  startRefused: (kind: string, name: string, message: string, code: string) =>
    `Herdr could not start ${kind} as ${name}: ${message} (${code}).`,

  // ---- failures ----
  agentBlocked: "The agent is waiting at a prompt; answer it first (see /herdr read).",
  herdrRefused: (message: string, code: string) => `Herdr refused: ${message} (${code}).`,
  pluginError: (message: string) => `Herdr plugin error: ${message}`,

  // ---- targets ----
  levelName: (level: TargetLevel): string =>
    ({
      pane_id: "pane id",
      terminal_id: "terminal id",
      agent_name: "agent name",
      tab_label: "tab label",
      agent_kind: "agent kind",
    })[level],
  useTerminalId: "use a terminal id",
  usePaneId: "use a pane id",
  noAgentRunning: "Herdr sees no running coding agent.",
  severalAgents: (candidates: string) => `Several agents are running; name one: ${candidates}.`,
  selectorHasServer: (selector: string) =>
    `${selector} looks like a selector@server target; machine suffixes are resolved per machine.`,
  labelOnTabs: (selector: string, count: number, tabs: string, hint: string, candidates: string) =>
    `${selector} labels ${count} tabs (${tabs}); ${hint}: ${candidates}.`,
  ambiguousTarget: (selector: string, count: number, level: string, hint: string, candidates: string) =>
    `${selector} matches ${count} agents by ${level}; ${hint}: ${candidates}.`,
  noMatchNoAgents: (selector: string) => `No agent matches ${selector}; Herdr sees no running coding agent.`,
  noMatch: (selector: string, candidates: string) => `No agent matches ${selector}. Running: ${candidates}.`,
  targetSyntax: (problem: TargetSyntaxProblem): string => {
    switch (problem.kind) {
      case "empty":
        return `"${problem.target}" is not a target: it is empty.`;
      case "empty_selector":
        return `"${problem.target}" is not a target: the selector before "@" is empty.`;
      case "selector_at":
        return `"${problem.target}" is not a target: a selector cannot contain "@".`;
      case "bad_server":
        return `"${problem.target}" is not a target: "@${problem.server}" is not a valid machine suffix.`;
    }
  },
  server: (problem: ServerProblem): string => {
    if (problem.kind === "ambiguous_label") {
      return `"${problem.server}" names ${problem.ids.length} saved machines; use a profile id instead: ${problem.ids.join(", ")} (see herdr machine list).`;
    }
    const why = problem.catalogError
      ? ` I could not read the machine list: ${problem.catalogError}.`
      : problem.remoteDisabled
        ? " Remote machines are disabled in the plugin config."
        : "";
    return `I know no Herdr server called "${problem.server}". Known: ${problem.known.join(", ")}.${why}`;
  },

  // ---- command grammar ----
  targetHint: "a pane id (w6:p1), an agent name, a tab label (sample#reviewer), or an agent kind when unique (claude, codex)",
  statusNotTarget: (text: string, hint: string) => `"${text}" is not a target. Usage: /herdr status [target] — ${hint}.`,
  readUsage: (min: number, max: number, hint: string) =>
    `Usage: /herdr read <target> [lines ${min}-${max}] — target is ${hint}.`,
  readNotTarget: (target: string, min: number, max: number, args: string) =>
    `"${target}" is not a target. Usage: /herdr read <target> [lines ${min}-${max}]; to send prose use /herdr <target>: ${args}.`,
  readExtra: (min: number, max: number) =>
    `Usage: /herdr read <target> [lines ${min}-${max}] — one target and one line count.`,
  readBadCount: (count: string, min: number, max: number) =>
    `"${count}" is not a line count; use a whole number between ${min} and ${max}.`,
  startUsage: "Usage: /herdr start <name> [kind] [pane id or cwd] — e.g. /herdr start reviewer codex ~/project",
  startUsageDefault: (usage: string, kind: string) => `${usage} (kind defaults to ${kind}).`,
  startBadName: (raw: string) =>
    `"${raw}" is not a usable agent name: lowercase letters, digits, "_" or "-", up to 32 characters, optionally @machine.`,
  startBadToken: (token: string, usage: string) => `Did not understand "${token}". ${usage}.`,
  watchUsage: (word: string, hint: string) => `Usage: /herdr ${word} <target> — ${hint}.`,
  watchOneTarget: (word: string, hint: string) => `Usage: /herdr ${word} <target> — one target only; ${hint}.`,
  invalidExplicitTarget: (head: string, hint: string) =>
    `"${head}" is not a valid target, so nothing was sent. A target is ${hint}, optionally followed by @machine.`,
  help: (min: number, max: number, hint: string): string[] => [
    "Herdr commands:",
    "/herdr list — agents Herdr sees",
    "/herdr <target>: <prompt> — send and watch",
    "/herdr <prompt> — send to the only agent",
    "/herdr status [target]",
    `/herdr read <target> [lines ${min}-${max}]`,
    "/herdr watch <target> · /herdr unwatch <target>",
    "/herdr start <name> [kind] [pane id or cwd] — start an agent (kind defaults to claude) in that pane, or in a new one",
    `Targets: ${hint}; a pane id wins over a name, a name over a tab label, a tab label over a kind.`,
    "Add @machine to target a saved Herdr machine: w9:p1@buildbox",
    "list/status/read/watch/unwatch/start are commands: to send a prompt that starts with one, use /herdr <target>: <prompt>.",
  ],
};

export type Messages = typeof EN;

/**
 * Spanish. Short on purpose: it is read on a phone. Command syntax and
 * placeholders are identical to the English catalog.
 */
const ES: Messages = {
  noAgentKind: "sin agente",
  noRunningAgent: "Herdr no ve ningún agente en marcha. Arranca claude o codex en un panel de Herdr.",
  agentsHeader: "Agentes en Herdr:",
  noAgentOnHost: "ningún agente en este equipo",
  noAgentThere: "ningún agente allí",
  machineHeader: (label) => `Máquina ${label}:`,
  machineDown: (label, reason) => `Máquina ${label}: caída — ${reason}`,
  machineListUnavailable: (reason) => `Lista de máquinas no disponible: ${reason}`,
  watchingMark: "vigilando",
  watchingSince: (timestamp) => `vigilando desde ${timestamp}`,
  cannotReachHerdr: (reason) => `No puedo conectar con Herdr: ${reason}. ¿Está en marcha el servidor de Herdr?`,
  cannotReachMachine: (label, reason) => `No puedo conectar con ${label}: ${reason}.`,
  onMachine: (label, message) => `En ${label}: ${message}`,

  sentTo: (ref, label) => `Enviado a **${ref}** (${label}).`,
  trackingWatching: "Te aviso cuando termine o necesite algo.",
  trackingOff: "Sin vigilancia; consulta con /herdr status.",
  trackingFailed: "Se entregó, pero no pude activar la vigilancia, así que no podré avisarte cuando termine; usa /herdr status.",
  blockedNotSent: (ref) => `${ref} está esperando una respuesta, así que no envié nada.`,
  blockedAnswerInTerminal:
    "Lee la pregunta de abajo y respóndela en el terminal (Herdr o Collie); responder desde el chat aún no está implementado.",
  sendUnconfirmed: (ref, reason) => `No pude confirmar el envío a **${ref}**: ${reason}.`,
  sendMaybeDeliveredWatching: "Puede que se haya entregado; sigo vigilando, así que revisa /herdr status antes de reenviar.",
  sendMaybeDelivered: "Puede que se haya entregado; revisa /herdr status antes de reenviar.",
  nothingSent: (ref, why) => `No se envió nada a ${ref}. ${why}`,
  readOnly: (ref, label) => [
    `No envié nada a **${ref}**: ${label} es de solo lectura.`,
    `Añade "${label}" a remote.allowSend en la configuración del plugin para permitir prompts allí.`,
  ],
  readEmpty: (ref) => `${ref} aún no muestra nada.`,

  watchNeedsSession: "Para vigilar hace falta una sesión de OpenClaw a la que avisar.",
  watchFailed: (ref, reason) => `No estoy vigilando ${ref}: ${reason}. Inténtalo de nuevo cuando responda.`,
  watchStarted: (ref, status) => `Vigilando ${ref} (${status}). Te aviso cuando termine o se bloquee.`,
  currentTask: "(tarea actual)",
  agentFallback: "agente",
  watcherNotRunning: "El vigilante no está en marcha.",
  unwatchedCount: (ref, count) => `Dejé de vigilar ${ref} (${count} vigilancia${count === 1 ? "" : "s"}).`,
  unwatched: (ref) => `Dejé de vigilar ${ref}.`,
  notWatched: (ref) => `${ref} no estaba vigilado.`,
  watchedElsewhere: (ref) => `${ref} lo vigila otro chat, no este.`,

  notification: (kind, who) => {
    switch (kind) {
      case "blocked":
        return `Herdr: ${who} necesita tu respuesta.`;
      case "exited":
        return `Herdr: ${who} ha salido.`;
      case "occupant_changed":
        return `Herdr: ${who} ya no está; ese panel ejecuta otra cosa, así que dejé de vigilarlo.`;
      case "timed_out":
        return `Herdr: ${who} sigue sin terminar al vencer el plazo de vigilancia.`;
      case "finished":
        return `Herdr: ${who} ha terminado.`;
    }
  },
  blockedAnswerHint: "Respóndelo en el terminal (Herdr o Collie): no puedo responder por ti mientras el agente está bloqueado.",
  blockedReadHint: (ref) => `/herdr read ${ref} vuelve a mostrar la pregunta. Responder desde el chat aún no está implementado.`,

  startNameTaken: (ref, kind, pane) => `${ref} ya ejecuta ${kind} en **${pane}**; elige otro nombre.`,
  startNoPane: (ref) => `No existe el panel ${ref}.`,
  startPaneBusy: (ref, kind) => `${ref} ya ejecuta ${kind}; Herdr necesita un panel con la shell libre.`,
  started: (name, kind, ref, created) => `Arrancado **${name}** (${kind}) en **${ref}**${created ? " (panel nuevo)" : ""}.`,
  startSendHint: (target) => `Envíale trabajo con /herdr ${target}: <prompt>.`,
  startRefused: (kind, name, message, code) => `Herdr no pudo arrancar ${kind} como ${name}: ${message} (${code}).`,

  agentBlocked: "El agente está esperando una respuesta; contéstala primero (ver /herdr read).",
  herdrRefused: (message, code) => `Herdr rechazó la petición: ${message} (${code}).`,
  pluginError: (message) => `Error del plugin Herdr: ${message}`,

  levelName: (level) =>
    ({
      pane_id: "id de panel",
      terminal_id: "id de terminal",
      agent_name: "nombre de agente",
      tab_label: "etiqueta de pestaña",
      agent_kind: "tipo de agente",
    })[level],
  useTerminalId: "usa un id de terminal",
  usePaneId: "usa un id de panel",
  noAgentRunning: "Herdr no ve ningún agente en marcha.",
  severalAgents: (candidates) => `Hay varios agentes en marcha; elige uno: ${candidates}.`,
  selectorHasServer: (selector) =>
    `${selector} parece un destino selector@servidor; los sufijos de máquina se resuelven por máquina.`,
  labelOnTabs: (selector, count, tabs, hint, candidates) =>
    `${selector} etiqueta ${count} pestañas (${tabs}); ${hint}: ${candidates}.`,
  ambiguousTarget: (selector, count, level, hint, candidates) =>
    `${selector} coincide con ${count} agentes por ${level}; ${hint}: ${candidates}.`,
  noMatchNoAgents: (selector) => `Ningún agente coincide con ${selector}; Herdr no ve ningún agente en marcha.`,
  noMatch: (selector, candidates) => `Ningún agente coincide con ${selector}. En marcha: ${candidates}.`,
  targetSyntax: (problem) => {
    switch (problem.kind) {
      case "empty":
        return `"${problem.target}" no es un destino: está vacío.`;
      case "empty_selector":
        return `"${problem.target}" no es un destino: falta el selector antes de "@".`;
      case "selector_at":
        return `"${problem.target}" no es un destino: un selector no puede contener "@".`;
      case "bad_server":
        return `"${problem.target}" no es un destino: "@${problem.server}" no es un sufijo de máquina válido.`;
    }
  },
  server: (problem) => {
    if (problem.kind === "ambiguous_label") {
      return `"${problem.server}" nombra ${problem.ids.length} máquinas guardadas; usa un id de perfil: ${problem.ids.join(", ")} (ver herdr machine list).`;
    }
    const why = problem.catalogError
      ? ` No pude leer la lista de máquinas: ${problem.catalogError}.`
      : problem.remoteDisabled
        ? " Las máquinas remotas están desactivadas en la configuración del plugin."
        : "";
    return `No conozco ningún servidor Herdr llamado "${problem.server}". Conocidos: ${problem.known.join(", ")}.${why}`;
  },

  targetHint:
    "un id de panel (w6:p1), un nombre de agente, una etiqueta de pestaña (sample#reviewer) o un tipo de agente si es único (claude, codex)",
  statusNotTarget: (text, hint) => `"${text}" no es un destino. Uso: /herdr status [target] — ${hint}.`,
  readUsage: (min, max, hint) => `Uso: /herdr read <target> [lines ${min}-${max}] — target es ${hint}.`,
  readNotTarget: (target, min, max, args) =>
    `"${target}" no es un destino. Uso: /herdr read <target> [lines ${min}-${max}]; para enviar texto usa /herdr <target>: ${args}.`,
  readExtra: (min, max) => `Uso: /herdr read <target> [lines ${min}-${max}] — un destino y un número de líneas.`,
  readBadCount: (count, min, max) => `"${count}" no es un número de líneas; usa un entero entre ${min} y ${max}.`,
  startUsage: "Uso: /herdr start <name> [kind] [pane id or cwd] — p. ej. /herdr start reviewer codex ~/project",
  startUsageDefault: (usage, kind) => `${usage} (kind por defecto: ${kind}).`,
  startBadName: (raw) =>
    `"${raw}" no sirve como nombre de agente: minúsculas, dígitos, "_" o "-", hasta 32 caracteres, opcionalmente @machine.`,
  startBadToken: (token, usage) => `No entendí "${token}". ${usage}.`,
  watchUsage: (word, hint) => `Uso: /herdr ${word} <target> — ${hint}.`,
  watchOneTarget: (word, hint) => `Uso: /herdr ${word} <target> — un solo destino; ${hint}.`,
  invalidExplicitTarget: (head, hint) =>
    `"${head}" no es un destino válido, así que no envié nada. Un destino es ${hint}, opcionalmente seguido de @machine.`,
  help: (min, max, hint) => [
    "Comandos de Herdr:",
    "/herdr list — agentes que ve Herdr",
    "/herdr <target>: <prompt> — enviar y vigilar",
    "/herdr <prompt> — enviar al único agente",
    "/herdr status [target]",
    `/herdr read <target> [lines ${min}-${max}]`,
    "/herdr watch <target> · /herdr unwatch <target>",
    "/herdr start <name> [kind] [pane id or cwd] — arranca un agente (kind por defecto: claude) en ese panel o en uno nuevo",
    `Destinos (target): ${hint}; un id de panel gana a un nombre, un nombre a una etiqueta de pestaña y una etiqueta a un tipo.`,
    "Añade @machine para una máquina Herdr guardada: w9:p1@buildbox",
    "list/status/read/watch/unwatch/start son comandos: para enviar un prompt que empiece por uno, usa /herdr <target>: <prompt>.",
  ],
};

const CATALOGS: Record<Language, Messages> = { en: EN, es: ES };

export function messages(language: Language): Messages {
  return CATALOGS[language];
}

/**
 * The plugin's `language` setting. Exactly `en` or `es`, as in the manifest;
 * anything else (another language, a region tag, a typo, a non-string) falls
 * back to English and is reported so the caller can log it. Absent means
 * English, silently.
 */
export function readLanguage(value: unknown): { language: Language; invalid?: string } {
  if (value === undefined) return { language: DEFAULT_LANGUAGE };
  if (isLanguage(value)) return { language: value };
  return { language: DEFAULT_LANGUAGE, invalid: typeof value === "string" ? JSON.stringify(value) : String(value) };
}
