# Análisis de openclaw-herdr

Fecha: 20 de septiembre de 2026. Revisión del árbol de trabajo local.

## Dictamen

La arquitectura es apropiada para un plugin pequeño y mantenible. El proyecto implementa una base funcional de control de agentes, pero el seguimiento y la entrega de resultados todavía no tienen la fiabilidad necesaria para operación desatendida. La etiqueta M0 del README es coherente con su madurez. No consideraría validada la promesa de «envía y recibirás el resultado» hasta corregir las pérdidas de eventos y comprobar el circuito completo de Telegram.

El problema principal no es el estilo de código: es el modelo de estado asíncrono. Se confunden el último estado observado, el progreso de una tarea, la identidad del ocupante del panel y la entrega de una notificación.

## Alcance y evidencia

Se revisaron todos los módulos de src, los seis archivos de tests, scripts/smoke.ts, manifiesto, configuración TypeScript, CI, README, arquitectura, plan y ADR. También se contrastó la existencia de las interfaces de notificación con las declaraciones del OpenClaw instalado.

Resultados ejecutados:

- `npm test`: 23 tests aprobados, seis archivos.
- `npm run typecheck`: aprobado.
- `npm run smoke`: aprobado; incluye compilación. Conectó con Herdr 0.9.1, protocolo 22, encontró un agente y ejecutó consultas de diagnóstico y lectura.
- Cinco reproducciones adicionales con cliente/notificador simulados y WatchStore real en directorios temporales: confirmaron los fallos descritos abajo.

No se enviaron prompts a agentes reales ni mensajes a Telegram. El smoke no valida la entrega proactiva ni el ciclo de envío/finalización. No se modificaron fuentes, tests ni configuración; permanecen los cambios previos del usuario en README y assets. La compilación actualizó únicamente artefactos ignorados en dist.

## Funcionalidad real

El plugin registra `/herdr` y cinco herramientas: listar, enviar, leer, vigilar y consultar estado. El comando añade ayuda y cancelación de vigilancia. Resuelve destinos por panel, terminal, nombre o tipo de agente, consulta Herdr mediante socket Unix y delega en su API la clasificación del estado.

El envío llama a `agent.prompt`, consulta el agente de nuevo y crea una vigilancia persistente cuando hay sesión y servicio disponibles. Cada vigilancia abre una suscripción. Al detectar terminación, bloqueo, salida o vencimiento, lee la cola del panel e inserta contexto en la sesión de OpenClaw; después solicita un heartbeat.

Está implementado el rechazo de envíos a agentes bloqueados. No está implementada la respuesta remota a sus menús/preguntas, aunque algunos mensajes la sugieren. Tampoco se crean agentes o paneles, se controlan máquinas remotas ni se identifica de forma sólida cada turno. Estas últimas limitaciones son coherentes con el alcance inicial documentado.

## Hallazgos prioritarios

### 1. Alta: ventana de pérdida entre envío y suscripción

Referencia: `src/openclaw/runtime.ts:109-115`; `src/core/watcher.ts:93-112`.

El prompt se entrega antes de abrir y confirmar la suscripción. Si el agente termina rápidamente, su transición final puede ocurrir durante `getAgent`, la escritura del JSON o el establecimiento del socket. Además, aunque `getAgent` ya devuelva `done`, el runtime lo sustituye por `working`. Sin otra transición posterior, la vigilancia queda pendiente hasta el vencimiento.

La misma clase de pérdida existe al iniciar o reconectar: el watcher vuelve a suscribirse, pero nunca consulta `getAgent` para reconciliar lo ocurrido durante la desconexión. Restaurar el JSON no equivale a recuperar el resultado.

Corrección: disponer de confirmación explícita de suscripción y reconciliación mediante API nativa al conectar/reconectar. Diseñar el orden de envío, observación y reconciliación con la semántica real de Herdr; no inventar `working` ni asumir que un estado identifica un turno.

### 2. Alta: `working → unknown → idle` pierde la finalización

Referencia: `src/core/watcher.ts:128-134`.

Se actualiza `lastStatus` a `unknown`. Cuando llega `idle`, el watcher solo acepta que el estado inmediatamente anterior fuese `working` o `blocked`, por lo que descarta el final aunque sí observó trabajo previamente.

Reproducción confirmada: cero notificaciones y una vigilancia abierta tras esa secuencia.

Corrección: separar «se observó trabajo desde el inicio de esta vigilancia» del último estado. `unknown` debe conservar la incertidumbre sin borrar evidencia de trabajo previo.

### 3. Alta: avisos fallidos no se reintentan como resultado pendiente

Referencia: `src/core/watcher.ts:149-167`.

Si falla el notificador tras recibir `idle`, se conserva la vigilancia, pero `lastStatus` ya es `idle`. Otro `idle` se descarta y el barrido solo actúa cuando vence el plazo, notificando entonces `timed_out`. Puede perderse el resultado real y acabar comunicándose que no terminó.

Corrección: persistir un resultado pendiente de entrega, separado de la observación del agente. Reintentar con backoff e idempotencia y retirar la vigilancia solo después de confirmar el encolado según el contrato del host.

### 4. Alta: los eventos se procesan concurrentemente

Referencia: `src/core/watcher.ts:101`, `115-161`.

Los handlers asíncronos se lanzan con `void`, sin serialización por vigilancia ni exclusión de una finalización en curso. Una finalización y una salida próximas pueden leer y notificar el mismo registro antes de que desaparezca. También puede competir un bloqueo lento con una transición posterior.

Reproducción confirmada: `done` y `pane.exited` simultáneos produjeron dos llamadas al notificador, `exited` y `done`. Sus claves de idempotencia son distintas, por lo que no se deduplican entre sí.

Corrección: cola por vigilancia o transición de finalización exclusiva; coordinar eventos, barridos, cancelaciones y parada del servicio.

### 5. Alta: errores de persistencia pueden escapar del servicio

Referencia: `src/core/watcher.ts:51`, `101`, `128`, `156-167`.

Las tareas disparadas con `void` no tienen captura final de errores. Un rechazo de `store.update/remove`, por ejemplo por disco lleno o permisos, puede convertirse en una promesa rechazada sin manejar. La consecuencia concreta depende del host y su configuración; al ejecutarse dentro del Gateway, el alcance potencial supera este plugin.

Corrección: capturar errores en cada frontera asíncrona, registrar contexto y conservar estado recuperable. Durante `stop`, esperar o cancelar trabajo pendiente.

### 6. Alta: ambigüedad de destino resuelta hacia otro agente

Referencia: `src/core/targets.ts:34-36`.

Cuando hay más de una coincidencia exacta, no se devuelve ambigüedad: se intenta resolver por tipo. Dos agentes con nombre `codex` y un tercero de tipo Codex hacen que se seleccione el tercero. También puede existir una colisión entre nombre e identificador de panel.

Reproducción confirmada con datos simulados: resultado `ok: true` hacia el tercer agente. No se verificó qué restricciones de unicidad de nombres impone Herdr; el fallo existe en la función de resolución ante ese conjunto de entradas.

Corrección: establecer precedencia explícita entre identificadores y nombres, y rechazar múltiples coincidencias dentro de cada nivel antes de pasar al siguiente.

### 7. Media: reemplazar vigilancias deja sockets abiertos

Referencia: `src/core/watch-store.ts`, método `add`; `src/core/watcher.ts:70-94`.

El almacén sustituye el registro anterior del panel por uno con UUID nuevo. El watcher intenta cerrar por el UUID nuevo, por lo que la suscripción antigua permanece en el mapa. Sus eventos se ignoran, pero sigue consumiendo recursos hasta desconexión o parada.

Reproducción confirmada: crear dos vigilancias del mismo panel y cancelarlo deja cero registros y una suscripción abierta.

Corrección: cerrar y retirar la suscripción del registro reemplazado como parte de la misma operación lógica.

### 8. Media: un estado nuevo se interpreta como finalización

Referencia: `src/core/watcher.ts:126-135`; `src/core/format.ts`, `formatNotification`.

El cast a `AgentStatus` no valida datos en ejecución. Cualquier cadena no vacía distinta de los estados tratados puede llegar a `settle`; el formateador usa «finished» como caso por defecto y elimina la vigilancia.

Reproducción confirmada con `paused_future`: se llamó al notificador y se eliminó la vigilancia. Es un riesgo de compatibilidad futura o datos inesperados, no una afirmación de que Herdr emita hoy ese estado.

Corrección: aceptar explícitamente los estados terminales conocidos y conservar estados no reconocidos como incertidumbre. Ignorar campos nuevos no significa atribuir semántica terminal a valores nuevos.

### 9. Media: secuencia e identidad guardadas pero no usadas

Referencia: `src/core/watch-store.ts`, `WatchRecord`; `src/core/watcher.ts:78`, `118-119`.

`seqAtStart` y `terminalId` se persisten, pero no filtran ni validan eventos. El comentario que promete ignorar eventos antiguos no corresponde a la implementación. La correlación efectiva usa únicamente `pane_id`.

No se ha demostrado una reutilización real de identificadores; el riesgo es que una vigilancia sobreviva a un cambio de ocupante y atribuya al trabajo anterior una transición posterior.

Corrección: verificar identidad con `agent.get` y utilizar secuencias donde la API realmente las exponga. Si los eventos no incorporan información suficiente, reconocer la limitación y consultar Herdr; no interpretar pantallas.

### 10. Media: sesiones distintas se pisan

Referencia: `src/core/watch-store.ts`, `add/byPane`; `src/openclaw/runtime.ts`, `watch/unwatch`.

Solo existe una vigilancia global por panel. Una segunda sesión reemplaza silenciosamente el destino de notificación de la primera. `unwatch` tampoco recibe identidad de sesión para comprobar quién cancela.

Esto importa si el Gateway se usa desde varios chats o usuarios; en una instalación estrictamente monousuario el impacto es menor. No implica por sí solo una vulneración de la autorización de OpenClaw.

Corrección: decidir y documentar si se permite un propietario exclusivo o múltiples suscriptores por panel; aplicar esa política a crear, listar y cancelar.

### 11. Media: entrega proactiva pendiente de validación

Referencia: `src/openclaw/notifier.ts:18-37`; `docs/adr/0003-notify-via-next-turn-injection.md`.

Las interfaces de encolado y heartbeat existen en el SDK instalado, pero el proyecto fuerza el contrato local con `as unknown as HostApi`, reduciendo la comprobación de compatibilidad. El heartbeat es opcional y no se verifica el campo `enqueued`. Encolar contexto no prueba que Telegram haya recibido el aviso.

La clave `watchId:status` tampoco distingue varios bloqueos legítimos dentro de la misma tarea. Según la vigencia de la deduplicación del host, puede suprimir un bloqueo posterior; requiere prueba de integración, no está confirmado por las reproducciones realizadas.

Corrección: validar el circuito real y sus condiciones de entrega; comprobar compatibilidad del adaptador con tipos del SDK y asignar identidad a cada evento lógico.

## Calidad, mantenibilidad y límites adicionales

Fortalezas:

- Separación clara entre transporte, dominio e integración; runtime compartido por comandos y herramientas.
- API nativa como fuente de verdad; no se clasifica el estado interpretando texto de terminal.
- TypeScript estricto, `noUncheckedIndexedAccess` y `exactOptionalPropertyTypes`.
- Cliente pequeño, timeout de peticiones y errores de transporte diferenciados.
- Persistencia con escrituras serializadas y reemplazo por rename; permisos restrictivos en archivos/directorios nuevos.
- CI con instalación reproducible, tests, tipos y build; dependencias de runtime reducidas.
- Documentación de decisiones y reconocimiento explícito del estado de prototipo.

Debilidades complementarias:

- `WatchStore.load` solo comprueba que `watches` sea array: no valida registros ni versión. JSON corrupto impide arrancar; fechas inválidas pueden impedir vencimientos. La atomicidad evita archivos parciales normales, pero no sustituye validación, recuperación ni garantías ante fallo de disco.
- `subscribe` no tiene timeout de confirmación. Un servidor que acepta el socket y no confirma puede dejar una vigilancia muda sin disparar reconexión. El decoder no limita el tamaño de línea/buffer.
- El parser acepta `read ... 0` y hasta 9999 líneas, mientras la herramienta limita 1–400. Entradas incompletas como `watch` pasan a ser prompts. Los errores sintácticos deberían distinguirse de texto libre cuando empieza un comando reservado.
- Un error al guardar la vigilancia después de enviar devuelve un error genérico aunque el prompt ya se entregó. El usuario puede repetirlo y duplicar trabajo. Debe distinguirse «enviado, seguimiento fallido» de «no enviado» y «entrega incierta».
- `waitFor` permite timeout del servidor mayor que el timeout fijo del transporte: un consumidor puede perder la espera prematuramente. Actualmente no participa en el flujo principal.
- El límite de mensajes es por líneas, no caracteres: una línea enorme puede generar una respuesta inadecuada para chat. Las comillas de código incluidas en la salida tampoco se escapan.
- La notificación de bloqueo invita a responder mediante `/herdr`, pero ese envío se rechaza mientras el estado sea `blocked`. Ajustar los textos a las funciones existentes.
- `private: true` impide publicar el paquete en npm, coherente con M0 pero pendiente para M4.

## Seguridad y confianza

El diseño evita ejecutar shells para controlar agentes y exige autorización en el comando; son decisiones positivas. El socket es local y las herramientas son opcionales. No se encontraron versiones exactas de Herdr, Claude Code o Codex fijadas como condición de uso.

La autorización del chat permite controlar agentes con sus permisos existentes: la política del Gateway y la del agente siguen siendo relevantes. El código del plugin no aporta aislamiento entre sesiones sobre un panel compartido.

La cola del terminal se incorpora al contexto del LLM como texto. Puede contener instrucciones procedentes de archivos o procesos y datos sensibles que acabarían en el chat de destino. Es una frontera de confianza que merece delimitación explícita y pruebas; no se ha demostrado aquí explotación ni exfiltración. Para retransmisión literal, valorar un mecanismo de entrega determinista si el host lo ofrece, sin convertir salida del terminal en instrucciones del sistema.

## Evaluación de tests

Los 23 tests cubren framing, gramática básica, resolución usual, transporte normal, algunos errores y transiciones sencillas. Son una buena base M0, pero no representan la complejidad temporal del watcher.

No hay pruebas dedicadas de notifier, formato, persistencia defectuosa o wiring real del plugin. Los tests del watcher no cubren reconexión con reconciliación, finalización durante el envío, reemplazo, deadlines, fallos de notificación, identidad del ocupante o múltiples sesiones. Usan pausas temporales y un fake con un handler por panel, que no reproduce bien varias suscripciones simultáneas. Varios fixtures no paran servicios ni limpian directorios temporales.

`tsconfig.json` excluye test de su conjunto de entrada: el typecheck no verifica los archivos de tests. Vitest los ejecuta, pero eso no equivale a validación estática.

El smoke consulta y abre brevemente una suscripción, pero no exige observar un evento y su callback de error solo escribe en stderr. Su salida `ok` no debe interpretarse como validación integral de las notificaciones.

## Orden recomendado de trabajo

1. Corregir el núcleo de seguimiento: secuenciación por vigilancia, progreso persistente, recuperación al reconectar y cierre de suscripciones reemplazadas. Añadir regresiones de los cinco casos reproducidos.
2. Separar resultado observado de entrega pendiente, con reintento y manejo de errores de disco/notificación; definir semántica de parada y cancelación.
3. Corregir ambigüedades de destino y política entre sesiones. No atribuir resultados a un ocupante distinto sin validación nativa.
4. Validar un ciclo real desde Telegram: envío, finalización, bloqueo repetido, reinicio y recuperación, sin interacción adicional del usuario para recibir el resultado.
5. Alinear mensajes, límites y README con lo comprobado; endurecer validación del almacén y del protocolo. Después avanzar hacia publicación.

Criterio de aceptación: cada tarea seguida debe producir un resultado atribuible al agente correcto y a la sesión correcta, sin pérdidas silenciosas, sin suscripciones huérfanas y con estado recuperable si la notificación falla. No hace falta reescribir el proyecto; hace falta completar y probar ese contrato.
