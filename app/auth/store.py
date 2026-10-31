"""
Persistência das contas de usuário — Supabase com fallback JSON local.

Segue EXATAMENTE o padrão de `app/database/videos.py`:

  * Com SUPABASE_URL/SUPABASE_KEY no .env → tabela `usuarios` (o DDL está em
    supabase/schema.sql, é só rodar no SQL Editor do painel).
  * Sem credenciais → arquivo JSON local (padrão: `data/usuarios.json`, a
    pasta `data/` já é ignorada pelo .git) com lock de processo e escrita
    atômica, igual ao `local_store.py` dos vídeos.

Assim o login funciona de ponta a ponta em dev (sem rede) e em produção
(Supabase) sem nenhuma mudança em quem chama.

Registro de usuário (contrato do módulo):

    {
      "usuario_id":   "<uuid>",
      "nome":         "Maria Silva",
      "email":        "maria@exemplo.com",       (sempre minúsculo)
      "senha_hash":   "pbkdf2_sha256$...$...$...",
      "tipo_usuario": "aluno" | "professor",
      "criado_em":    "<iso 8601>"
    }

Importante: `senha_hash` nunca sai daqui para as respostas HTTP — o router
monta a representação pública com `remover_segredos()`.
"""
from __future__ import annotations

import json
import logging
import os
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path

from app.database.client import get_client

logger = logging.getLogger(__name__)

TABLE = "usuarios"

TIPOS_USUARIO = ("aluno", "professor")

# Raiz do repositório: API e testes precisam resolver o MESMO caminho.
RAIZ_PROJETO = Path(__file__).resolve().parents[2]
CAMINHO_PADRAO = RAIZ_PROJETO / "data" / "usuarios.json"

_lock = threading.Lock()

_aviso_dado = False


def caminho_do_banco() -> Path:
    return Path(os.getenv("USERS_DB_PATH", str(CAMINHO_PADRAO)))


# ---------------------------------------------------------------------------
# Backend local (JSON)
# ---------------------------------------------------------------------------

def _ler() -> list[dict]:
    """Lê as contas; arquivo ausente ou corrompido vira lista vazia."""
    caminho = caminho_do_banco()
    if not caminho.is_file():
        return []
    try:
        conteudo = json.loads(caminho.read_text(encoding="utf-8"))
        return conteudo if isinstance(conteudo, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _escrever(usuarios: list[dict]) -> None:
    """Escrita atômica: grava num temporário e renomeia no lugar."""
    caminho = caminho_do_banco()
    caminho.parent.mkdir(parents=True, exist_ok=True)
    temporario = caminho.with_suffix(".tmp")
    temporario.write_text(
        json.dumps(usuarios, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    temporario.replace(caminho)


# ---------------------------------------------------------------------------
# Backend Supabase
# ---------------------------------------------------------------------------

def _cliente_supabase():
    """Client do Supabase ou None quando ele não está configurado.

    O aviso é logado uma única vez (mesma política do módulo de vídeos) para
    não poluir os logs — cada login/registro passaria por aqui.
    """
    global _aviso_dado
    try:
        return get_client()
    except RuntimeError as exc:
        if not _aviso_dado:
            logger.warning(
                "Supabase não configurado — contas de usuário no banco local "
                "%s. (%s)", caminho_do_banco(), exc,
            )
            _aviso_dado = True
        return None


# ---------------------------------------------------------------------------
# API pública do store
# ---------------------------------------------------------------------------

def normalizar_email(email: str) -> str:
    """E-mail é a identidade de login: sempre minúsculo e sem espaços."""
    return str(email or "").strip().lower()


def remover_segredos(usuario: dict | None) -> dict | None:
    """Cópia pública do registro — SEM o hash de senha (nunca vai na resposta)."""
    if usuario is None:
        return None
    return {
        chave: valor
        for chave, valor in usuario.items()
        if chave != "senha_hash"
    }


def criar_usuario(nome: str, email: str, senha_hash: str,
                  tipo_usuario: str = "aluno") -> dict | None:
    """Insere uma conta nova. Devolve None se o e-mail já existir.

    A verificação de duplicidade é feita ANTES do insert nos dois backends;
    no Supabase a constraint UNIQUE de `email` (schema.sql) ainda protege
    contra corrida entre duas requisições simultâneas.
    """
    if tipo_usuario not in TIPOS_USUARIO:
        raise ValueError(
            f"tipo_usuario deve ser um de {TIPOS_USUARIO}, veio {tipo_usuario!r}"
        )

    email = normalizar_email(email)
    registro = {
        "usuario_id": str(uuid.uuid4()),
        "nome": str(nome).strip(),
        "email": email,
        "senha_hash": senha_hash,
        "tipo_usuario": tipo_usuario,
        "criado_em": datetime.now(timezone.utc).isoformat(),
    }

    client = _cliente_supabase()
    if client is None:
        with _lock:
            usuarios = _ler()
            if any(item.get("email") == email for item in usuarios):
                return None
            usuarios.append(registro)
            _escrever(usuarios)
        return dict(registro)

    existente = (
        client.table(TABLE).select("usuario_id").eq("email", email).execute()
    )
    if existente.data:
        return None

    response = client.table(TABLE).insert(registro).execute()
    return response.data[0]


def buscar_por_email(email: str) -> dict | None:
    """Busca a conta pelo e-mail de login (minúsculo). None se não existir."""
    email = normalizar_email(email)

    client = _cliente_supabase()
    if client is None:
        for usuario in _ler():
            if usuario.get("email") == email:
                return dict(usuario)
        return None

    response = client.table(TABLE).select("*").eq("email", email).execute()
    return response.data[0] if response.data else None


def buscar_por_id(usuario_id: str) -> dict | None:
    """Busca a conta pelo usuario_id (uuid). None se não existir."""
    client = _cliente_supabase()
    if client is None:
        for usuario in _ler():
            if usuario.get("usuario_id") == usuario_id:
                return dict(usuario)
        return None

    response = (
        client.table(TABLE).select("*").eq("usuario_id", usuario_id).execute()
    )
    return response.data[0] if response.data else None


def listar(tipo_usuario: str | None = None) -> list[dict]:
    """Lista as contas, opcionalmente filtrando por tipo (aluno/professor)."""
    client = _cliente_supabase()
    if client is None:
        usuarios = _ler()
        if tipo_usuario:
            usuarios = [
                item for item in usuarios
                if item.get("tipo_usuario") == tipo_usuario
            ]
        return [dict(item) for item in usuarios]

    consulta = client.table(TABLE).select("*")
    if tipo_usuario:
        consulta = consulta.eq("tipo_usuario", tipo_usuario)
    response = consulta.order("criado_em").execute()
    return list(response.data)
