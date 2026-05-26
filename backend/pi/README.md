# backend/pi — Pedal Hidrográfico auto-hospedado

Um único serviço Flask que **serve o app do mapa, valida uploads RDF/imagem e
persiste tudo em arquivos**, sem dependência de nuvem nem SQLite.

> A pasta se chama `pi` por histórico, mas o `main.py` é Python puro e roda
> igual num **Raspberry Pi** ou num **macOS** (ver o fim).

```text
Raspberry Pi
  └─ gunicorn → main.py (Flask)
        ├─ GET  /                      → web/index.html (o app)
        ├─ GET  /<path>                → estáticos de web/ (app.js, fotos, ttl, …)
        ├─ POST /upload-image          → multipart: ttl + variantes;
        │                                valida com pyshacl, grava em web/
        └─ POST /delete-image/<phash>  → apaga arquivos + triples
  └─ cloudflared → túnel HTTPS público
```

Arquivos: `main.py`, `requirements.txt`, `phidro.service` (Linux),
`phidro.plist` (macOS).

## O estado vive em `web/`

Não há mais SQLite nem `PHIDRO_DATA` separado: o catálogo de fotos é
**`web/data/photos.ttl`** (Turtle) e cada foto vive em
**`web/photos/<phash>/{original,large,thumb}.<ext>`**. O Pi serve esses
arquivos diretamente como estáticos para o app — mesma origem, sem CORS.

```text
web/
├─ index.html, app.js, style.css, sw.js, manifest.json, icons…
├─ upload_images.html          formulário de envio (POSTa em /upload-image)
├─ lib/                        utils.js + n3.min.js (parser de Turtle vendored)
├─ data/
│   ├─ photos.ttl              catálogo único; gerado/mantido pelo /upload-image
│   ├─ tours.ttl               catálogo de passeios (gerado por build-tours.py)
│   ├─ shapes.ttl              SHACL — validação do /upload-image
│   └─ ontology.ttl            vocabulário ph:
└─ photos/<phash>/             { original.jpg | large.jpg | thumb.jpg }
```

A validação SHACL acontece contra `web/data/shapes.ttl` mesclado com
`web/data/ontology.ttl`. O Pi lê esses arquivos do próprio diretório web/
que serve.

**Backup é copiar `web/data/` + `web/photos/`** — não há mais nada de
estado. (`web/routes.json` é regenerado por `scripts/build-routes.py`.)

## 1. Sistema

Use **Raspberry Pi OS de 64 bits** — `rdflib`/`pyshacl` precisam só do
Python (sem dependências nativas), mas o 64 bits acelera tudo. Pi 4 ou 5
recomendado. Considere apontar o repositório para um SSD/HD USB em vez do
cartão SD (as fotos crescem, e o SD desgasta com escrita).

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

## 3. Teste local

```sh
./venv/bin/python main.py        # sobe em http://0.0.0.0:8000
```

Abra `http://<ip-do-pi>:8000/` na rede local — o mapa deve carregar. Para
testar o fluxo de upload, abra `http://<ip-do-pi>:8000/upload_images.html`.
`Ctrl-C` para parar.

Variáveis úteis: `PORT` (padrão `8000`) e `PHIDRO_WEB` (padrão
`../../web`, o sibling do `main.py`).

## 4. Serviço no boot (systemd)

Edite `phidro.service` — confira os caminhos — e:

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

`web/app.js` e `web/upload_images.html` usam caminhos relativos
(`./data/photos.ttl`, `./photos/<phash>/large.jpg`, `./upload-image`,
`./delete-image/<phash>`). Como o Pi serve o app e a API na **mesma
origem**, funciona sem CORS e sem configurar URLs.

## Limitações e notas

- **Camada de topografia colorida:** os tiles `rmsampa-v2` estavam no GCS.
  Sem a nuvem, essa sobreposição não carrega. O mapa-base do OpenStreetMap
  (externo, gratuito) continua funcionando; só o relevo colorido some até
  você hospedar esses tiles em algum lugar (o Pi pode servi-los como
  arquivos estáticos, se você tiver a pirâmide de tiles).
- **Segurança:** não há autenticação — presume-se que quem alcança o
  servidor é de confiança. Qualquer um que abrir a URL pode enviar e apagar
  fotos. Se isso deixar de valer, restrinja o acesso na borda (regra do
  Cloudflare Tunnel, lista de IPs, VPN) ou reintroduza um token.
- **HEIC:** o Pi não decodifica mais imagem — `upload_images.html` converte
  HEIC para JPEG no browser (via `heic2any`) e envia variantes prontas.
  Servidor não precisa de `pillow-heif`.

## Rodar no macOS em vez do Pi

O `main.py` não muda — Flask, rdflib e pyshacl são Python puro. Só duas
coisas diferem do Pi.

**Instalar (Homebrew):**

```sh
brew install python cloudflared
cd /Users/<voce>/pedalhidrografico/backend/pi
python3 -m venv venv
./venv/bin/pip install -r requirements.txt
```

**Rodar no boot — launchd, não systemd.** Use o `phidro.plist` desta pasta
(é o equivalente macOS do `phidro.service`). Edite-o trocando o usuário e os
caminhos, depois:

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
