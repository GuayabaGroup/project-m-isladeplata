# Contenido de plataforma (Nivel B — H9.2)

Markdown comercial y de onboarding por plataforma, inyectado al subgrafo `query`
cuando un **staff** pregunta por el producto. Cargado al boot por
`PlatformContentLoader` (`src/infrastructure/content/`). **Sin hot-reload**:
editar requiere reiniciar isladeplata.

```
content/
  commercial/   allia.md  groomia.md  divapp.md   ← qué es, precios/planes, features, contratación
  onboarding/   allia.md  groomia.md  divapp.md   ← setup, subir servicios/staff, WhatsApp, horarios, URL de reservas
```

## Estado

Los 6 archivos arrancan **vacíos**. Mientras un archivo esté vacío (o ausente),
`PlatformContentLoader.get()` retorna `undefined` y el subgrafo query **escala a
soporte determinísticamente** en lugar de dejar que el LLM invente pasos, menús,
botones, precios o URLs (§9 anti-alucinación).

Completar un archivo (y reiniciar) activa las respuestas automáticas para esa
plataforma + tipo de contenido.

## Plantilla sugerida

**commercial/*.md**

```markdown
# <Plataforma>

## ¿Qué es?
## Planes y precios
## Features principales
## Para quién es
## Cómo contratar / contacto comercial
## FAQ
```

**onboarding/*.md**

```markdown
# <Plataforma> — Primeros pasos

## Configurar el negocio
## Cargar servicios
## Agregar al equipo (staff)
## Conectar WhatsApp
## Configurar horarios / disponibilidad
## Compartir la URL de reservas con clientes
## Cómo agendan los clientes
```

> El contenido se inyecta literal (markdown sin escapar). Escribir en el idioma
> y tono de cara al staff; el agente responde desde acá, no inventa.
