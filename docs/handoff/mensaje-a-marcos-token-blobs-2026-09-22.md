# Mensaje para Marcos — token de Netlify y merge del PR #7 (22 sep 2026)

Marcos, olvida lo de añadirme al equipo: eso sí pide plan de pago, pero **un token no
cuesta nada**. Y con un token me vale.

El que está en el `.env` funcionaba el 18 de septiembre (escribió 747 partes en
Blobs) y hoy da 401. Lo han rotado o le han bajado permisos. Sácame uno nuevo:

## Token

1. https://app.netlify.com → tu foto, arriba a la derecha → **User settings**.
2. **Applications** → sección **Personal access tokens** → **New access token**.
3. Descripción: `lexicoil-blobs`. Expiración: la que quieras (o sin expiración).
4. **Generate token** → cópialo.
5. Pásamelo por WhatsApp, no por el repo ni por el PR.

Solo se ve una vez; si lo pierdes, generas otro y ya.

## Merge del PR #7

1. Abre https://github.com/marcosdadone96/lexicoil/pull/7
2. Baja del todo, hasta el final de la página.
3. Botón verde **Merge pull request**.
4. **Confirm merge**.

Ya está. Producción se despliega sola desde `main`, no tienes que tocar Netlify.

Si antes quieres mirar algo, en la pestaña **Files changed** está todo el diff. Los
dos checks están en verde.
