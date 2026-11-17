# Traduc: traducción en vivo de la prédica

Traduc permite que las personas que no hablan el idioma de la prédica la sigan desde su
propio celular. Una computadora capta el audio del servicio y lo envía a OpenAI; cada persona
escanea un código QR, elige su idioma y escucha la traducción con audífonos o la lee en pantalla.

Fue creado para una iglesia de habla hispana con visitantes de habla inglesa, pero funciona
con cualquier idioma de origen que el modelo entienda (más de 70).

## Qué incluye

- **Página de control** (`/admin`): inicia y detiene la transmisión, muestra el nivel de audio,
  una vista previa de la traducción, cuántas personas escuchan cada idioma y el código QR.
- **Página de oyentes** (`/`): la persona elige su idioma, escucha el audio traducido y lee el
  texto. Puede cambiar el tamaño de la letra, y el audio sigue con la pantalla bloqueada.
- **Pantalla del templo** (`/pantalla?lang=en`): solo subtítulos grandes, para proyectar.
- **Texto de la prédica**: al terminar se descarga la traducción en PDF.

Idiomas de salida: inglés, portugués, francés, alemán, italiano, japonés, coreano, chino, ruso,
hindi, indonesio y vietnamita.

## Cómo funciona

```
Consola de sonido → computadora (página de control en Chrome)
                         │ audio
                         ▼
                   servidor Traduc ──► OpenAI (gpt-realtime-translate), una sesión por idioma en uso
                         │ audio + texto traducidos
                         ▼
            celulares de los oyentes y pantalla del templo
```

Un idioma solo se traduce mientras alguien lo tiene abierto, así que no se paga por los
idiomas que nadie usa.

## Requisitos

- Una computadora con [Node.js](https://nodejs.org) 22.9 o más reciente y Google Chrome.
- Una cuenta de [OpenAI](https://platform.openai.com) con saldo y una clave de API con acceso
  al modelo `gpt-realtime-translate`.
- Internet estable en la computadora que transmite.
- Recomendado: un cable de la salida auxiliar de la consola de sonido a la computadora. La
  traducción es mucho mejor con el audio directo que con un micrófono de ambiente.

## Costo

OpenAI cobra por minuto de audio y por idioma activo: 0.034 USD por minuto, unos 2 USD por
hora e idioma (precio de noviembre de 2026; confírmalo en la
[página de precios de OpenAI](https://platform.openai.com/docs/pricing)). No importa cuántas
personas escuchen un mismo idioma. El software es gratuito.

## Instalación

1. Descarga el proyecto e instala las dependencias:

   ```bash
   git clone <dirección-de-este-repositorio> traduc
   cd traduc
   npm install
   ```

2. Crea tu archivo de configuración a partir del ejemplo:

   ```bash
   cp .env.example .env
   ```

3. Abre `.env` y completa:
   - `OPENAI_API_KEY`: tu clave de OpenAI (se crea en https://platform.openai.com/api-keys).
   - `ADMIN_PIN`: un número que solo conozca quien opera la transmisión.
   - `LANGUAGES`: los idiomas que quieres ofrecer; por ejemplo `en` si solo necesitas inglés.

   El archivo `.env` contiene tu clave: no lo compartas ni lo subas a ningún repositorio.

4. Prueba sin gastar. Este modo no usa OpenAI; los celulares reciben pitidos y texto de ejemplo:

   ```bash
   npm run mock
   ```

5. Inicia el servidor real:

   ```bash
   npm start
   ```

   La Terminal muestra la dirección de control, el PIN y la dirección para los oyentes.

## Uso en un servicio

1. Conecta la consola de sonido a la computadora e inicia el servidor.
2. Abre la página de control en Chrome (`http://localhost:3000/admin`) y escribe el PIN.
3. Elige la entrada de audio y comprueba que la barra de nivel se mueve cuando hay sonido.
4. Pulsa **Iniciar transmisión** y deja esa pestaña abierta. En "Vista previa de la traducción"
   verás el texto traducido.
5. Muestra el código QR (está al final de la página de control). Cada oyente lo escanea, elige
   su idioma y pulsa **Listen**. Necesita sus propios audífonos.
6. Al terminar, pulsa **Detener transmisión** y descarga el PDF en "Texto de la prédica".

Para proyectar los subtítulos, abre `/pantalla?lang=en` en la computadora del proyector.
Agrega `&size=5` para cambiar el tamaño de la letra.

Sobre el texto guardado:

- Solo se guarda lo traducido mientras el idioma está encendido. La vista previa de la página
  de control mantiene encendido su idioma, así ese texto queda completo.
- Se conserva en la memoria del servidor: descárgalo antes de cerrar la página de control. Se
  borra al iniciar otra prédica; si reinicias en menos de 30 minutos, continúa el mismo texto.
- El PDF está disponible para inglés, portugués, francés, alemán, italiano e indonesio. Los
  demás idiomas se descargan como archivo de texto.

## Cómo llegan los celulares al sitio

Hay tres formas, de la más simple a la más cómoda:

### 1. Mismo wifi

Por defecto el QR apunta a la dirección de la computadora en la red local. Los celulares deben
estar en el mismo wifi, y la red no debe aislar los dispositivos entre sí. Sin `https`, algunos
celulares apagan la pantalla mientras se escucha.

### 2. Túnel (recomendado para empezar)

Un túnel da una dirección `https` pública que también funciona con datos móviles. Con
[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
cloudflared tunnel --url http://localhost:3000
```

Copia la dirección `https` que muestra en `PUBLIC_URL` dentro de `.env` y reinicia el servidor
para que el QR la use. La dirección cambia cada vez que abres el túnel.

### 3. Servidor en la nube (dirección fija)

El servidor puede vivir en cualquier servicio que ejecute Node.js y admita WebSockets. La
computadora de la iglesia solo abre la página de control. Ejemplo con Google Cloud Run:

```bash
# Una sola vez
gcloud services enable run.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com
printf 'TU_CLAVE_DE_OPENAI' | gcloud secrets create openai-api-key --data-file=-
printf 'TU_PIN' | gcloud secrets create admin-pin --data-file=-

# La cuenta de servicio de Compute necesita compilar y leer los secretos
NUM=$(gcloud projects describe "$(gcloud config get-value project)" --format='value(projectNumber)')
SA="serviceAccount:$NUM-compute@developer.gserviceaccount.com"
gcloud projects add-iam-policy-binding "$(gcloud config get-value project)" --member="$SA" --role=roles/run.builder
gcloud secrets add-iam-policy-binding openai-api-key --member="$SA" --role=roles/secretmanager.secretAccessor
gcloud secrets add-iam-policy-binding admin-pin --member="$SA" --role=roles/secretmanager.secretAccessor

# Publicar (y volver a publicar tras cada cambio)
gcloud run deploy traduc --source . --region us-central1 --allow-unauthenticated \
  --max-instances 1 --timeout 3600 \
  --set-secrets "OPENAI_API_KEY=openai-api-key:latest,ADMIN_PIN=admin-pin:latest"

# Con la dirección que devuelve el comando anterior
gcloud run services update traduc --region us-central1 --update-env-vars PUBLIC_URL=https://TU-DIRECCION
```

`--max-instances 1` es obligatorio: el servidor guarda su estado en memoria y no puede
repartirse entre varias instancias. Cloud Run corta cada conexión a los 60 minutos; las
páginas se reconectan solas en uno o dos segundos.

## Configuración

Todas las opciones van en `.env` (o como variables de entorno en la nube).

| Variable | Para qué sirve | Valor por defecto |
|---|---|---|
| `OPENAI_API_KEY` | Clave de OpenAI. Obligatoria. | — |
| `ADMIN_PIN` | PIN de la página de control. | Uno aleatorio en cada arranque |
| `LANGUAGES` | Idiomas ofrecidos, separados por coma. | Los 12 disponibles |
| `PUBLIC_URL` | Dirección que abre el QR. | La IP local de la computadora |
| `PORT` | Puerto del servidor. | `3000` |
| `TRANSLATE_ENGINE` | `auto`, `translate` o `prompt` (ver abajo). | `auto` |
| `PROMPT_MODEL` | Modelo del motor de respaldo. | `gpt-realtime-2.1` |
| `TIME_ZONE` | Zona horaria para la fecha del PDF. | `America/Mexico_City` |

### Motor de traducción

- `translate` usa `gpt-realtime-translate`, un modelo hecho para interpretar: traduce de forma
  continua mientras el orador habla.
- `prompt` usa un modelo de voz general con instrucciones de intérprete. Traduce en cada pausa
  del orador, así que va más atrasado. Sirve de respaldo si tu clave no tiene acceso al primero.
- `auto` intenta `translate` y pasa a `prompt` si OpenAI niega el acceso.

## Problemas frecuentes

- **"The model gpt-realtime-translate does not exist or you do not have access to it"**: tu
  clave no tiene permiso para ese modelo. En https://platform.openai.com revisa los límites y
  modelos permitidos de tu proyecto, y si tu organización necesita verificación. Después de
  habilitarlo puede tardar unos minutos en funcionar de forma estable.
- **La barra de nivel no se mueve**: elige otra entrada de audio y revisa que Chrome tenga
  permiso para usar el micrófono.
- **El celular no abre el sitio**: no está en el mismo wifi, o la red aísla los dispositivos.
  Usa un túnel o un servidor en la nube.
- **No se oye en el celular**: hay que pulsar **Listen** (los navegadores no reproducen audio
  solos), subir el volumen y revisar los audífonos.
- **La traducción confunde nombres o términos bíblicos**: el modelo no admite glosarios. Mejora
  con audio limpio directo de la consola.

## Limitaciones y privacidad

- La traducción es automática y puede tener errores; llega unos segundos después del orador.
- El audio del servicio se envía a OpenAI para traducirlo. Revisa sus condiciones de uso de
  datos y avisa a tu congregación si corresponde.
- Cualquiera con el enlace puede escuchar. La página de control está protegida solo por el PIN:
  elige uno que no sea fácil de adivinar.

## Licencia

MIT. Consulta el archivo [LICENSE](LICENSE).
