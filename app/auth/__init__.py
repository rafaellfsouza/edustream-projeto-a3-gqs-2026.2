"""
Módulo de autenticação — login de alunos e professores (EduStream).

Antes deste módulo a plataforma não sabia QUEM estava assistindo: o player
enviava sempre o `USER_ID` fixo do config.js ("demo-user") no POST /watch, e
as recomendações "personalizadas" eram, na prática, as mesmas para todo mundo.

Agora o fluxo é:

    1. O usuário cria uma conta em /player/login.html escolhendo o perfil
       (aluno ou professor) — POST /auth/registrar.
    2. Faz login (POST /auth/login) e recebe um TOKEN assinado, guardado no
       localStorage do navegador.
    3. O player envia esse token no cabeçalho `Authorization: Bearer ...`:
         * POST /watch atribui a visualização ao usuário logado;
         * GET /recomendacoes/me devolve as recomendações pessoais dele
           (motor de Jaccard sobre as tags do histórico — app/recommendations).
    4. Professores ainda têm GET /auth/usuarios (lista de contas da
       plataforma) — rota bloqueada para alunos (403).

Peças do módulo:
    passwords.py    hash de senha (PBKDF2-HMAC-SHA256, stdlib)
    tokens.py       token de sessão assinado (HMAC-SHA256, stdlib — sem PyJWT)
    store.py        persistência das contas (Supabase com fallback JSON local,
                    o mesmo padrão de app/database/videos.py)
    dependencies.py dependências FastAPI (usuario_atual, exigir_professor)
    router.py       rotas HTTP (/auth/*)

Decisão de projeto: NENHUMA dependência nova no requirements.txt — tudo usa
`hashlib`, `hmac` e `secrets` da biblioteca padrão. O projeto continua
instalando com o mesmo comando e o CI não muda.
"""
