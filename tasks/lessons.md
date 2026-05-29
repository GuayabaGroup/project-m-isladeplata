# Lessons — Isladeplata

## LangGraph `StateGraph` + TS2589 al agregar nodos

**Patrón**: El grafo de `compile.ts` tiene ~43 nodos en una sola cadena fluida
`new StateGraph().addNode()...`. Agregar **2 nodos nuevos** disparó
`TS2589: Type instantiation is excessively deep` — la cadena acumula el union de
nombres de nodo en el tipo genérico y cruza el límite de profundidad de TS.

**Qué NO funcionó**:
- Partir la cadena en segmentos (`const a = ...; const b = a...`) — no reduce la
  profundidad acumulada del tipo final.
- Fijar `N = string` con genéricos explícitos en el constructor — otros type
  params (`NodeReturnType`, etc.) igual acumulan.

**Qué funcionó**: **No agregar nodos nuevos**. Reusar nodos terminales existentes.
Para P-human-takeover, el handoff a humano se ruteó al `social_responder` (que ya
emite outcome) en vez de un nodo `request_human` dedicado, y el juez de
frustración (capa C) se inyectó como helper dentro de `classify_intent` en vez de
un nodo `detect_frustration`. Resultado: 0 nodos nuevos, 43 nodos → compila.

**Regla para mí**: Antes de `addNode` en `compile.ts`, evaluar si la lógica puede
colgar de un nodo existente (fast-path del supervisor, helper dentro de un nodo).
Solo agregar un nodo si el flujo lo exige de verdad. Si hubiera que crecer mucho,
refactorizar el grafo a subgrafos compilados por separado (compose), no una sola
cadena gigante.
