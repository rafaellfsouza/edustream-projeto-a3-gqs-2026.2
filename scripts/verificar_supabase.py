"""Smoke test do BANCO Supabase (Postgres) — tabela `videos` + `usuarios`.

Uso (na raiz do repositório, com o venv ativado):
    python scripts/verificar_supabase.py

O que ele faz:
    1. lê o .env da raiz e confere SUPABASE_URL / SUPABASE_KEY;
    2. conecta com o supabase-py (o MESMO client que o backend usa);
    3. em `videos`:   insert → select → delete de um registro de teste;
    4. em `usuarios`: insert → select → delete de uma conta de teste
       (é a tabela da feature de autenticação — app/auth/store.py).

Sai com código 0 se tudo passar. Se alguma tabela não existir, a mensagem
manda rodar o supabase/schema.sql no SQL Editor do painel.

Para o smoke test do STORAGE (bucket de mídia HLS), o script é outro:
    python scripts/teste_storage.py
"""
from __future__ import annotations

import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))  # permite rodar de qualquer cwd


def carregar_dotenv() -> None:
    """Injeta o .env da raiz no os.environ (variáveis já definidas vencem)."""
    import os

    dotenv = REPO_ROOT / ".env"
    if not dotenv.is_file():
        return
    for linha in dotenv.read_text(encoding="utf-8").splitlines():
        linha = linha.strip()
        if not linha or linha.startswith("#") or "=" not in linha:
            continue
        chave, _, valor = linha.partition("=")
        os.environ.setdefault(chave.strip(), valor.strip().strip('"').strip("'"))


def dica_de_erro(exc: Exception) -> str:
    """Traduz os erros comuns do PostgREST em instrução acionável."""
    mensagem = str(exc).lower()
    if "could not find the table" in mensagem or "does not exist" in mensagem:
        return (
            "A tabela não existe no projeto. Rode o conteúdo de "
            "supabase/schema.sql no painel do Supabase → SQL Editor → New "
            "query → Run (cria `videos` e `usuarios`, é idempotente)."
        )
    if "invalid api key" in mensagem or "401" in mensagem or "403" in mensagem:
        return (
            "Credenciais recusadas. Confira SUPABASE_KEY no .env — a chave "
            "`anon public` está em Settings → API no painel."
        )
    if "name or service not known" in mensagem or "getaddrinfo" in mensagem:
        return (
            "Não resolveu o host — confira SUPABASE_URL no .env "
            "(formato https://xxxx.supabase.co, sem barra no final)."
        )
    return ""


def checar_tabela_videos(client) -> bool:
    """insert → select → delete na tabela `videos` (contrato #2)."""
    video_id = str(uuid.uuid4())  # a coluna é uuid no Postgres
    registro = {
        "video_id": video_id,
        "titulo": "[smoke] registro de teste — pode apagar",
        "descricao": "Criado por scripts/verificar_supabase.py; removido em seguida.",
        "tags": "smoke,teste",
        "categoria": "QA",
        "autor": "verificar_supabase.py",
        "status": "pending",
    }

    try:
        client.table("videos").insert(registro).execute()
        lido = client.table("videos").select("*").eq("video_id", video_id).execute()
        if not lido.data:
            print("[ERRO] videos: insert ok, mas o select não devolveu a linha.")
            return False
        client.table("videos").delete().eq("video_id", video_id).execute()
        print("[OK] videos: insert → select → delete funcionaram.")
        return True
    except Exception as exc:
        print(f"[ERRO] videos: {exc}")
        dica = dica_de_erro(exc)
        if dica:
            print(f"  -> {dica}")
        return False


def checar_tabela_usuarios(client) -> bool:
    """insert → select → delete na tabela `usuarios` (app/auth/store.py)."""
    sufixo = uuid.uuid4().hex[:10]
    registro = {
        "usuario_id": str(uuid.uuid4()),
        "nome": "Smoke Test",
        "email": f"smoke-{sufixo}@verificar.local",
        "senha_hash": "pbkdf2_sha256$1$smoke$smoke",  # hash fake: nunca valida
        "tipo_usuario": "aluno",
        "criado_em": datetime.now(timezone.utc).isoformat(),
    }

    try:
        client.table("usuarios").insert(registro).execute()
        lido = (
            client.table("usuarios").select("*")
            .eq("usuario_id", registro["usuario_id"]).execute()
        )
        if not lido.data:
            print("[ERRO] usuarios: insert ok, mas o select não devolveu a linha.")
            return False
        client.table("usuarios").delete().eq(
            "usuario_id", registro["usuario_id"]
        ).execute()
        print("[OK] usuarios: insert → select → delete funcionaram "
              "(contas do login podem usar o Supabase).")
        return True
    except Exception as exc:
        print(f"[ERRO] usuarios: {exc}")
        dica = dica_de_erro(exc)
        if dica:
            print(f"  -> {dica}")
        return False


def main() -> int:
    carregar_dotenv()

    import os

    url = (os.getenv("SUPABASE_URL") or "").strip()
    key = (os.getenv("SUPABASE_KEY") or "").strip()

    if not url or not key:
        print("[ERRO] SUPABASE_URL e/ou SUPABASE_KEY vazias no .env.")
        print("  -> Copie .env.example para .env e preencha com os dados do")
        print("     painel do Supabase (Settings → API). Sem elas o projeto")
        print("     funciona no banco JSON local (data/) — e este smoke test")
        print("     não tem o que verificar.")
        return 1

    print(f"[INFO] Testando conexão com {url}")

    try:
        from app.database.client import get_client

        client = get_client()
    except Exception as exc:
        print(f"[ERRO] Não foi possível criar o client: {exc}")
        return 1

    ok_videos = checar_tabela_videos(client)
    ok_usuarios = checar_tabela_usuarios(client)

    if ok_videos and ok_usuarios:
        print("\n[TUDO OK] O backend vai usar o Supabase (vídeos + contas de")
        print("usuário). Reinicie API e worker Celery se estavam no ar.")
        return 0

    print("\n[FALHOU] Corrija os pontos acima e rode de novo.")
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
