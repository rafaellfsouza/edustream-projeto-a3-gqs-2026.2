# Projeto A3 — Streaming de Vídeo Educacional

Plataforma de streaming de vídeo com processamento assíncrono e qualidade adaptativa, desenvolvida para a disciplina de Garantia e Gestão da Qualidade de Software (ODS 4 — Educação de Qualidade).

## Stack

| Camada | Tecnologia |
| --- | --- |
| API / Backend | Python + FastAPI |
| Processamento assíncrono | Redis + Celery |
| Transcodificação | FFmpeg |
| Streaming | HLS (HTTP Live Streaming) |
| Player | HLS.js + HTML5 Video |
| Banco de dados | Supabase (Postgres gerenciado) |
| Testes | Pytest |
| CI/CD | GitHub Actions |

## Pré-requisitos

**Opção A — via Docker (recomendado):**
- Docker Desktop
- Git

**Opção B — rodando localmente com Python:**
- Python 3.10+
- Docker Desktop (para rodar o Redis)
- FFmpeg instalado no sistema e disponível no PATH — [instruções aqui](https://ffmpeg.org/download.html)
- Git

## Como rodar o projeto — Opção A: via Docker (recomendado)

Essa é a forma mais simples: não precisa instalar Python, criar venv nem instalar nada manualmente — só o Docker.

### 1. Clonar o repositório

```bash
git clone https://github.com/rafaellfsouza/edustream-projeto-a3-gqs-2026.2
cd edustream-projeto-a3-gqs-2026.2
```

### 2. Criar o arquivo `.env`

```bash
cp .env.example .env
```

> Preencha `SUPABASE_URL` e `SUPABASE_KEY` com os dados do projeto Supabase do time (passo a passo na seção **Supabase** abaixo). Enquanto o `.env` estiver vazio, o backend funciona com o banco local `data/videos.json` — útil para desenvolver sem rede. **Nunca commite o `.env`**, só o `.env.example` (sem valores) vai pro Git.

### 3. Subir tudo com um comando

Com o Docker Desktop aberto:

```bash
docker compose up --build
```

Isso sobe o Redis e o worker do Celery juntos, dentro de containers. Se der tudo certo, você vai ver nos logs as filas (`uploads`, `transcode`, `notifications`), as tasks disponíveis e uma linha `celery@... ready.`

Pra parar, aperte `Ctrl+C` nesse terminal. Pra rodar em segundo plano (sem travar o terminal), use `docker compose up --build -d`.

## Como rodar o projeto — Opção B: localmente com Python

Use essa opção se quiser rodar o código diretamente na sua máquina (sem container), por exemplo pra debugar mais de perto.

### 1. Clonar o repositório

```bash
git clone https://github.com/rafaellfsouza/edustream-projeto-a3-gqs-2026.2
cd edustream-projeto-a3-gqs-2026.2
```

### 2. Criar e ativar o ambiente virtual

**Windows:**
```bash
python -m venv venv
venv\Scripts\activate
```

**Linux/Mac:**
```bash
python -m venv venv
source venv/bin/activate
```

Você saberá que o ambiente está ativo quando o prompt do terminal começar com `(venv)`.

### 3. Instalar as dependências

```bash
pip install -r requirements.txt
```

### 4. Configurar as variáveis de ambiente

```bash
cp .env.example .env
```

Preencha no `.env` (veja a seção **Supabase** abaixo):
```
SUPABASE_URL=...
SUPABASE_KEY=...
```
> Sem essas variáveis o backend cai no banco local `data/videos.json` (dev offline).

**Nunca commite o arquivo `.env`** — apenas o `.env.example` (sem valores) vai pro Git.

### 5. Subir o Redis

Com o Docker Desktop aberto:

```bash
docker compose up -d redis
```

Confirme que subiu:
```bash
docker ps
```

### 6. Rodar o worker do Celery

Em um terminal **separado** (com o venv ativado):

```bash
celery -A app.queue.celery_app worker --loglevel=info --pool=solo
```

> ⚠️ **Importante para quem está no Windows:** o Celery usa por padrão um pool de processos (`prefork`) que **não funciona no Windows** rodando localmente — ele trava com erros como `PermissionError: [WinError 5] Acesso negado` e fica derrubando processos filhos em loop. A flag `--pool=solo` faz o worker rodar em um único processo, o que resolve o problema. **Sempre use essa flag no Windows ao rodar localmente.** Dentro do Docker (Opção A) isso não é necessário, porque o container roda em Linux.

Se subiu certo, você deve ver as filas listadas (`uploads`, `transcode`, `notifications`) e as tasks disponíveis, terminando com uma linha `celery@... ready.`

### 7. Rodar a API

Em outro terminal (venv ativado):

```bash
uvicorn app.main:app --reload
```

### 8. Rodar os testes

```bash
pytest -v
```

## Supabase (banco compartilhado do time)

Com o Supabase configurado, **todo o time e o player passam a ver o mesmo catálogo e as mesmas contas de usuário** (os fallbacks locais `data/videos.json` e `data/usuarios.json` se desligam sozinhos). Uma vez por máquina:

1. **Criar as tabelas**: painel do Supabase → **SQL Editor** → cole e execute o conteúdo de [`supabase/schema.sql`](supabase/schema.sql) (idempotente: cria `videos` **e** `usuarios` + índices — a segunda é a do login de alunos/professores).
2. **Copiar as credenciais**: painel → **Settings → API Keys** (ou botão **Connect** no topo do projeto):
   - **Project URL**: `https://xxxx.supabase.co` (também aparece em Settings → General);
   - **Chave**: use a **publishable** (`sb_publishable_...`, aba *Publishable and secret API keys*). Projetos antigos ainda mostram a chave `anon` (JWT `eyJ...`) na aba *Legacy* — as duas funcionam, mas a `anon` será descontinuada no fim de 2026.

   Cole no `.env`:
   ```
   SUPABASE_URL=https://xxxx.supabase.co
   SUPABASE_KEY=sb_publishable_...
   ```
   O `.env` é carregado automaticamente no import do pacote `app` (não precisa exportar na mão). **Nunca** use a chave `sb_secret_...`/`service_role` no `.env` de dev compartilhado — ela bypassa todas as proteções do banco.
3. **Conferir a ligação**:
   ```bash
   python scripts/verificar_supabase.py
   ```
   O script valida as credenciais e faz insert → select → delete de teste nas DUAS tabelas (`videos` e `usuarios`). Se alguma não existir, ele manda rodar o `schema.sql`.
4. **Reiniciar** API e worker Celery para valerem as novas variáveis.

> Sem credenciais no `.env`, tudo continua funcionando localmente (banco JSON) — inclusive os testes, o login e a demo.

### Supabase Storage (opcional — mídia HLS no bucket)

Por padrão os vídeos transcodificados ficam no **disco da API** (`videos/`). Para guardá-los no bucket do Supabase (útil quando API e worker rodam em máquinas diferentes, ou para o player tocar de qualquer origem):

1. Painel → **Storage → Buckets** → crie um bucket público (ex.: `streaming`, **Public bucket ON**).
2. Painel → **Storage → Settings → S3 Access Keys** → gere um par de chaves.
3. Preencha no `.env`:
   ```
   ENABLE_S3=true
   S3_BUCKET=streaming
   AWS_ACCESS_KEY_ID=<access key do passo 2>
   AWS_SECRET_ACCESS_KEY=<secret key do passo 2>
   AWS_REGION=<região mostrada na página S3>
   AWS_ENDPOINT_URL=https://xxxx.supabase.co/storage/v1/s3
   # S3_PUBLIC_URL pode ficar vazio: a API deriva de SUPABASE_URL + S3_BUCKET.
   ```
4. Teste com `python scripts/teste_storage.py` (smoke test: sobe um arquivo `.txt` no bucket, confirma a leitura e imprime a URL pública) e reinicie a stack. O worker passa a publicar o HLS no bucket e o catálogo devolve `hls_url` apontando para lá.

## Autenticação — login de alunos e professores

A plataforma tem contas de usuário (`app/auth` no backend, `login.html` no player) e é o login que liga **os vídeos às recomendações de cada usuário**:

```
http://localhost:8000/player/login.html   ← entrar / criar conta (aluno ou professor)
```

### Como funciona o fluxo

```
POST /auth/registrar ──► cria a conta (perfil: aluno | professor) e devolve token
POST /auth/login ──────► valida e-mail + senha (hash PBKDF2) e devolve token
        │  token assinado (HMAC-SHA256, expira em 12h) guardado no localStorage
        ▼
POST /watch + Authorization: Bearer ──► view atribuída ao usuário LOGADO
GET  /recomendacoes/me ──► recomendações pessoais (Jaccard sobre as tags do
                           histórico dele) — home e sidebar "Recomendados para você"
GET  /auth/usuarios ──► área do PROFESSOR: contas cadastradas (aluno leva 403)
```

Sem login nada quebra: o player continua funcionando em modo anônimo (o
`POST /watch` aceita o `user_id` opcional de sempre e a home mostra só o
catálogo). Com login, cada visualização alimenta o histórico **daquela conta**
e a home/watch page exibem o bloco **"Recomendados para você"**.

### Onde as contas ficam guardadas

Mesma política dos vídeos (`app/database/videos.py`):

| Cenário | Armazenamento |
| --- | --- |
| `SUPABASE_URL`/`SUPABASE_KEY` no `.env` | tabela `usuarios` (rode o `supabase/schema.sql` no SQL Editor) |
| Sem credenciais (dev) | JSON local `data/usuarios.json` (pasta fora do Git) |

A senha **nunca** é gravada em texto claro — só o hash PBKDF2-HMAC-SHA256 com
sal aleatório. O token de sessão é assinado com `AUTH_SECRET_KEY`; em dev, sem
a variável, usa-se um segredo público de desenvolvimento (o backend avisa nos
logs). **Defina `AUTH_SECRET_KEY` no `.env` antes de qualquer deployment** —
gere um valor com `python -c "import secrets; print(secrets.token_urlsafe(48))"`.

### Rotas da API (todas em `/docs`)

| Rota | Quem chama | O que faz |
| --- | --- | --- |
| `POST /auth/registrar` | login.html (aba Criar conta) | cria conta e inicia a sessão |
| `POST /auth/login` | login.html (aba Entrar) | valida credenciais e inicia a sessão |
| `GET /auth/me` | menu de perfil | dados do usuário logado (401 sem token) |
| `GET /auth/usuarios` | professor | lista as contas (403 para aluno) |
| `GET /recomendacoes/me` | home/watch page | recomendações do usuário logado |
| `POST /watch` | player | com Bearer, atribui a view ao usuário real |

## Frontend ↔ Backend (o player conversando com a API)

Com a API no ar (`uvicorn app.main:app --reload`), o backend **também serve o player** — não precisa de outro servidor:

```
http://localhost:8000/player/home.html  ← home (catálogo que vem do banco)
http://localhost:8000/player/login.html ← login/cadastro (alunos e professores)
http://localhost:8000/player/           ← watch page (toca o 1º vídeo pronto)
http://localhost:8000/docs              ← documentação da API (Swagger)
http://localhost:8000/videos/...        ← HLS (master.m3u8, segmentos) e thumbnails
```

> O player **não tem URL de vídeo no JavaScript**: ele pergunta à API, que lê o
> banco (Supabase ou `data/videos.json`) e devolve o `hls_url` de cada vídeo +
> `media_pronta` (se o master.m3u8 existe mesmo no disco). Sem isso o player
> tentava reproduzir vídeos sem arquivo HLS e ficava num loop de retry em 404.

### Demo completa de ponta a ponta (recomendado)

Com API + Redis + worker Celery rodando (passos acima), em outro terminal:

```bash
python scripts/demo_completo.py
```

O script gera vídeos de teste com FFmpeg, faz o upload via `POST /upload`, acompanha a transcodificação pelo `GET /status/{video_id}`, registra visualizações e mostra o `/trending` e os `/videos/{id}/relacionados` respondendo com os vídeos reais. No fim, é só abrir a **home estilo YouTube** em **http://localhost:8000/player/home.html**: a grade lista os vídeos transcodificados (com busca por título/tag no topo) e cada card abre a página de watch já tocando o vídeo escolhido (`index.html?video={id}`). Abrir direto **http://localhost:8000/player/** também funciona: o player dá play automaticamente no primeiro vídeo do catálogo.

### Rodando o frontend separado (Live Server, http.server, etc.)

Também funciona: a API tem **CORS liberado para desenvolvimento**, então o player pode ser aberto de outra origem/porta. Nesse caso o `config.js` do player aponta a API para `http://localhost:8000` automaticamente. Para mudar a origem da API, edite `player-adaptativo/player-adaptativo/config.js`.

### Sem Supabase? Sem problema (dev local)

Enquanto o projeto Supabase não existe, o backend cai automaticamente num **banco JSON local** (`data/videos.json`, pasta ignorada pelo Git) — upload, catálogo, status e recomendações funcionam de ponta a ponta sem nenhuma configuração. Quando `SUPABASE_URL`/`SUPABASE_KEY` forem preenchidos no `.env`, o Supabase volta a ser usado sem mudar nenhuma outra linha.

> O Redis continua sendo necessário para a fila do Celery e para o contador de visualizações (`/trending`, `/watch`). `docker compose up -d redis` resolve.

### O fluxo completo da integração

```
POST /upload ──► grava arquivo + metadados (Supabase ou JSON local)
             └─► enfileira processar_upload no Celery (Redis)
                     └─► transcodificar_video (FFmpeg → HLS em videos/{id}/)
                             └─► status completed no Redis E no banco
GET /status/{id} ──► pending → processing → completed   (polling do front)
GET /media/{id} ───► master.m3u8/thumbnail/segmentos existem no disco?
GET /catalogo?prontos=1, /trending, /videos/{id}/relacionados ──► home + cards
GET /catalogo/{id} ──► watch page (index.html?video={id})
GET /videos/{id}/master.m3u8 ──► HLS.js toca o vídeo adaptativo
POST /auth/registrar, POST /auth/login ──► sessão (token Bearer no localStorage)
POST /watch (+Bearer) ──► ranking e histórico do usuário LOGADO
GET /recomendacoes/me ──► "Recomendados para você" (home + watch page)
```

## Modo rápido: subir tudo com um comando só

Em vez de abrir 4 terminais (Redis, worker, API, testes), use o launcher — com o venv ativado:

**Windows (PowerShell):**
```powershell
venv\Scripts\python.exe scripts\subir_tudo.py
```
**Linux/Mac:**
```bash
python scripts/subir_tudo.py
```

O script, em ordem: cria o `.env` se faltar; sobe o Redis via `docker compose` se a porta 6379 estiver muda; inicia o worker Celery (`--pool=solo`, o pool que funciona no Windows) e a API; espera o health check; e imprime as URLs da home/player/docs. Os logs ficam em `logs/` e os PIDs em `logs/*.pid`.

Variações úteis:
```bash
python scripts/subir_tudo.py --demo    # sobe tudo e roda a demo E2E em seguida
python scripts/subir_tudo.py --frente  # worker+API neste terminal (Ctrl+C derruba)
python scripts/parar_tudo.py           # derruba worker+API (Redis fica no ar)
```

## Testando se o Celery está funcionando (task de exemplo)

Com o worker rodando (seja pela Opção A ou B), abra **outro terminal**. Se estiver na Opção B, ative o venv nele também. Entre no shell do Python:

```bash
python
```

Dentro do shell:

```python
from app.queue.tasks import hello_world
resultado = hello_world.delay()
resultado.get(timeout=10)
```

Se tudo estiver certo, isso retorna `'pong'` e o terminal do worker (seja o log do `docker compose up` ou o terminal local) mostra a task sendo recebida e concluída (`received` → `succeeded`).

## O vídeo não toca? Um comando diz onde está o problema

```bash
python scripts/verificar_player.py
```

Ele confere, em ordem: API no ar → vídeos `completed` no banco → quais têm
`master.m3u8` no disco (`media_pronta`) → a playlist sendo servida com o
Content-Type certo → home e watch page acessíveis. É o mesmo diagnóstico que o
player faz na tela quando o play falha.

## Problemas comuns

| Erro | Causa provável | Solução |
| --- | --- | --- |
| `'celery' não é reconhecido como um comando` | O ambiente virtual não está ativado nesse terminal (Opção B) | Rode `venv\Scripts\activate` (Windows) ou `source venv/bin/activate` (Linux/Mac) antes |
| `O sistema não pode encontrar o caminho especificado` ao ativar o venv | A pasta `venv` não existe ainda | Rode `python -m venv venv` primeiro |
| `PermissionError: [WinError 5] Acesso negado` ao subir o worker localmente | Pool `prefork` do Celery não funciona no Windows | Suba o worker com `--pool=solo` (só necessário na Opção B) |
| Worker sobe mas a task nunca retorna | Redis não está rodando, ou está numa porta diferente | Confirme com `docker ps` que o Redis está ativo na porta 6379 |
| `env file ... not found` ao rodar `docker compose up` | Falta o arquivo `.env` na raiz do projeto | Rode `cp .env.example .env` (pode ficar vazio por enquanto) |
| `Cannot connect to redis://localhost:6379` dentro do container | Dentro do Docker, `localhost` aponta para o próprio container, não para o serviço do Redis | Já está resolvido no `docker-compose.yml` (usa `redis://redis:6379`); se acontecer de novo, confira se as variáveis `CELERY_BROKER_URL`/`CELERY_RESULT_BACKEND` do serviço `celery-worker` apontam para `redis`, não `localhost` |
| O player só mostra os vídeos de demonstração (cards fixos) | A API não está no ar, ou nenhum vídeo foi transcodificado ainda (o catálogo real vem do `/trending` + `/relacionados`) | Suba a API (`uvicorn app.main:app`) e rode `python scripts/demo_completo.py`; abra o console do navegador (F12) para ver os motivos de fallback |
| Player aberto via Live Server não fala com a API | O front está em outra origem (ex: `:5500`) | Já resolvido: a API tem CORS liberado em dev e o `config.js` aponta para `http://localhost:8000`. Confira se o backend está rodando |
| Vídeo tocando mas sem imagem / 404 no `.m3u8` | O arquivo HLS não existe em `videos/{id}/` (transcodificação não terminou ou falhou) | Consulte `GET /status/{video_id}`; se estiver `failed`, veja o log do worker Celery (FFmpeg instalado?) |
| O player diz "os arquivos HLS não foram encontrados" | Vídeo `completed` no banco, mas a pasta `videos/{id}/` não tem `master.m3u8` (ela não vai para o git — é gerada localmente) | `GET /media/{video_id}` mostra o que existe no disco; rode `python scripts/demo_completo.py` ou reenvie o vídeo pela home |
| A home está vazia, mas o `/catalogo` tem vídeos | Todos estão sem mídia (`prontos=1` filtra) ou com status diferente de `completed` | `GET /catalogo` (sem filtro) mostra todos; confira `media_pronta` de cada um |
| "A API não respondeu em http://localhost:8000" | Backend fora do ar, ou o front aberto em outra origem sem CORS | Suba `uvicorn app.main:app --reload`; se usar Live Server, confira o `API_BASE_URL` do `config.js` |

## Estrutura de pastas

```
projeto-a3/
├── .github/workflows/ci.yml       # Pipeline: pytest (back) + Jest (player)
├── app/
│   ├── main.py                    # FastAPI: rotas + CORS + /player + /videos
│   ├── auth/                      # Login: contas aluno/professor, PBKDF2, tokens
│   ├── upload/                    # POST /upload (salva arquivo e metadados, enfileira)
│   ├── queue/                     # Celery: tasks, broker e status em Redis
│   ├── transcoding/               # FFmpeg: HLS multi-resolução + thumbnail
│   ├── recommendations/           # Jaccard por tags + views (/trending, /relacionados, /recomendacoes/me)
│   ├── status/                    # GET /status/{video_id} (Redis, fallback banco)
│   └── database/                  # Supabase + fallback local (data/videos.json)
├── player-adaptativo/player-adaptativo/   # Frontend (HLS.js, servido em /player/)
│   ├── home.html                  # Catálogo (grade + busca + upload + recomendados)
│   ├── index.html                 # Página do player (watch page)
│   ├── login.html                 # Login/cadastro (alunos e professores)
│   ├── config.js                  # Origem da API (mesma origem ou localhost:8000)
│   └── js/                        # api.js, auth.js, login.js, catalog.js, player.js, home.js, ...
├── scripts/
│   ├── demo_completo.py           # Demo E2E: upload → fila → HLS → trending
│   ├── seed_e2e.py                # Cenário de teste do player (sem Redis/worker)
│   ├── verificar_player.py        # Diagnóstico: API + banco + mídia + páginas
│   └── gerar_video_teste.py       # Vídeo sintético via FFmpeg
├── uploads/                       # arquivos originais (dev local, fora do git)
├── videos/                        # HLS processado (dev local, fora do git)
├── data/                          # banco JSON local sem Supabase (fora do git)
├── docker-compose.yml             # redis + worker + api
├── Dockerfile
├── requirements.txt
└── .env.example
```

## Equipe

| Integrante | Módulo (branch) |
| --- | --- |
| Rafael | feature/upload-videos |
| Pietro | feature/processamento-assincrono |
| João | feature/transcodificacao |
| Gustavo | feature/recomendacoes |
| Pedro | feature/player-adaptativo |