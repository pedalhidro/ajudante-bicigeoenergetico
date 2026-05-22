# backend/pi — Pedal Hidrográfico auto-hospedado

Um único serviço Flask que **serve o app do mapa e é o backend das fotos**,
sem nenhuma dependência de nuvem: arquivos em disco, índice em SQLite.

> A pasta se chama `pi` por histórico, mas o `main.py` é Python puro e roda
> igual num **Raspberry Pi** (passos 1–6) ou num **macOS** (ver o fim).

```
Raspberry Pi
  └─ gunicorn → main.py (Flask)
        ├─ GET  /              → public/ (o app do mapa)
        ├─ GET  /fotos/...     → fotos processadas + photos.jsonld
        ├─ POST /sign-upload   → URL de PUT (token)
        ├─ PUT  /put/...       → recebe + processa a foto
        └─ POST /delete-photo  → apaga (token)
  └─ cloudflared → túnel HTTPS público
```

Arquivos: `main.py`, `requirements.txt`, `phidro.service` (Linux),
`phidro.plist` (macOS).

## A pasta de dados (`PHIDRO_DATA`)

`PHIDRO_DATA` aponta para a pasta que guarda **todo o acervo** — é o estado
do sistema, mantido de propósito separado do código. Deixe-a **fora do
repositório** (ex.: `/home/pi/phidro-data`) e, de preferência, num SSD/HD
USB, não no cartão SD (as fotos crescem e o SD se desgasta).

Não precisa criá-la à mão — o `main.py` cria as subpastas no primeiro
arranque. O conteúdo:

```
PHIDRO_DATA/
├─ originals/         arquivos originais, como enviados (HEIC/JPEG):
│                     o arquivo morto — nunca recomprimido
├─ fotos/             ← é esta pasta que o serviço publica em /fotos/
│  ├─ photos/         versão de exibição de cada foto  (JPEG ~1600 px)
│  ├─ thumbs/         miniatura de cada foto           (JPEG ~400 px)
│  └─ photos.jsonld   o manifesto que o app lê (recriado a cada mudança)
└─ photos.db          índice SQLite de todas as fotos — a fonte da verdade
```

`photos.db` é o índice; o `photos.jsonld` é derivado dele a cada upload ou
remoção. `originals/` o app não usa — é o arquivo bruto, de onde se
regeneraria tudo se preciso.

**Backup é copiar esta pasta.** Um `rsync` periódico de `PHIDRO_DATA` para
outro disco é todo o seu backup — não há redundância em nuvem.

## 1. Sistema

Use **Raspberry Pi OS de 64 bits** — é o que tem wheels prontas de
`pillow-heif` (decodificação de HEIC) para ARM64; no de 32 bits ele tentaria
compilar. Pi 4 ou 5 recomendado. Vale apontar `PHIDRO_DATA` para um
SSD/HD USB em vez do cartão SD (as fotos crescem e o SD desgasta).

```sh
sudo apt update
sudo apt install -y python3-venv python3-pip git
```

## 2. Repositório e ambiente

```sh
cd /home/pi
git clone <seu-repo> pedalhidrografico
cd pedalhidrografico/backend/pi
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

## 3. Token e teste

```sh
export UPLOAD_SECRET="<um-segredo-seu>"
export PHIDRO_DATA="/home/pi/phidro-data"
./venv/bin/python main.py        # sobe em http://0.0.0.0:8000
```

Abra `http://<ip-do-pi>:8000/` na rede local — o mapa deve carregar.
`Ctrl-C` para parar.

## 4. Serviço no boot (systemd)

Edite `phidro.service` — troque `UPLOAD_SECRET`, confira os caminhos — e:

```sh
sudo cp phidro.service /etc/systemd/system/phidro.service
sudo systemctl daemon-reload
sudo systemctl enable --now phidro
systemctl status phidro          # deve estar "active (running)"
```

O serviço escuta só em `127.0.0.1:8000` — quem o expõe é o túnel (passo 5).

## 5. HTTPS público — Cloudflare Tunnel

O app é um PWA (service worker, geolocalização) e **exige HTTPS**. A forma
mais simples, sem abrir portas no roteador nem IP fixo, é o Cloudflare
Tunnel (gratuito):

```sh
# instala o cloudflared (ARM64)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -o cloudflared && sudo mv cloudflared /usr/local/bin/ && sudo chmod +x /usr/local/bin/cloudflared

cloudflared tunnel login
cloudflared tunnel create phidro
# aponte um (sub)domínio seu para o túnel:
cloudflared tunnel route dns phidro pedalhidrografi.co
```

No arquivo de config do túnel (`~/.cloudflared/config.yml`), aponte o
serviço para `http://localhost:8000`, e rode o `cloudflared` como serviço
(`sudo cloudflared service install`). A Cloudflare cuida do HTTPS.

> Alternativa sem Cloudflare: encaminhar uma porta no roteador + DNS
> dinâmico + um proxy reverso (Caddy faz HTTPS automático via Let's
> Encrypt). É mais trabalho; o túnel é o caminho mais curto.

## 6. O app já está pronto

`public/app.js` usa caminhos relativos (`/sign-upload`, `/delete-photo`,
`/fotos/photos.jsonld`) — como o Pi serve o app e a API na **mesma origem**,
funciona sem CORS e sem configurar URLs. O token é pedido uma vez no
navegador e fica no `localStorage`.

## Limitações e notas

- **Camada de topografia colorida:** os tiles `rmsampa-v2` estavam no GCS.
  Sem a nuvem, essa sobreposição não carrega. O mapa-base do OpenStreetMap
  (externo, gratuito) continua funcionando; só o relevo colorido some até
  você hospedar esses tiles em algum lugar (o Pi pode servi-los como
  arquivos estáticos, se você tiver a pirâmide de tiles).
- **Segurança:** `/sign-upload` e `/delete-photo` exigem o token. O `/put`
  confia na URL (contém um uuid imprevisível que só o `/sign-upload`
  entrega) — mesma lógica da URL assinada da nuvem. Como o endpoint é
  público, mantenha o token só com quem deve enviar/apagar.
- **HEIC:** decodificação em ARM é mais lenta que num PC, mas para o volume
  do coletivo (poucas fotos por pedal) é tranquilo.

## Rodar no macOS em vez do Pi

O `main.py` não muda — Flask, Pillow e pillow-heif têm wheels de macOS
(Apple Silicon e Intel). Só duas coisas diferem do Pi.

**Instalar (Homebrew):**

```sh
brew install python cloudflared
cd /Users/<voce>/pedalhidrografico/backend/pi
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

**Rodar no boot — launchd, não systemd.** Use o `phidro.plist` desta pasta
(é o equivalente macOS do `phidro.service`). Edite-o trocando o usuário, os
caminhos e o `UPLOAD_SECRET`, depois:

```sh
sudo cp phidro.plist /Library/LaunchDaemons/co.pedalhidrografi.phidro.plist
sudo launchctl bootstrap system /Library/LaunchDaemons/co.pedalhidrografi.phidro.plist
sudo launchctl enable system/co.pedalhidrografi.phidro
# parar / recarregar:
#   sudo launchctl bootout system/co.pedalhidrografi.phidro
```

(Em macOS antigos, o equivalente é `sudo launchctl load -w <plist>`.)
Logs vão para `/tmp/phidro.log` e `/tmp/phidro.err`.

**Impedir o Mac de dormir** — um servidor não pode hibernar:

```sh
sudo pmset -a sleep 0          # desktop
sudo pmset -a disablesleep 1   # notebook (impede dormir com a tampa)
```

O passo 5 (Cloudflare Tunnel) é igual — o `cloudflared` veio pelo Homebrew.
O resto (token, app com caminhos relativos, backup da pasta de dados) é
idêntico ao do Pi.
