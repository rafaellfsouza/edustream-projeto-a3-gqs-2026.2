"""
Token de sessão — assinatura HMAC-SHA256 (stdlib), no espírito do JWT HS256.

Formato:  `base64url(payload).base64url(assinatura)`

O payload carrega a identidade pública do usuário e a expiração:

    {"sub": "<usuario_id>", "nome": "...", "email": "...",
     "tipo": "aluno"|"professor", "exp": <unix seconds>}

Por que não usar PyJWT?
  * Zero dependências novas (regra do módulo de autenticação) — HMAC-SHA256
    da biblioteca padrão é exatamente o algoritmo do JWT HS256.
  * O formato simples é fácil de explicar na apresentação e de testar.

A senha nunca entra no token. Quem valida a assinatura é `validar_token`,
que devolve None (em vez de levantar exceção) para token inválido/vencido —
as rotas transformam isso em 401.

Segredo: variável de ambiente AUTH_SECRET_KEY. Sem ela (dev em localhost)
usa-se um segredo fixo de desenvolvimento — aceitável porque o token só
protege dados de estudo, mas em qualquer deployment público a variável DEVE
ser definida (o README avisa).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import os
import time

logger = logging.getLogger(__name__)

# Duração padrão da sessão: um dia letivo inteiro de apresentação.
DURACAO_PADRAO_SEGUNDOS = 12 * 60 * 60

SEGREDO_DEV = "edustream-segredo-dev-nao-use-em-producao"

_aviso_segredo_dado = False


def _segredo() -> bytes:
    """Segredo de assinatura, lido do ambiente a cada chamada (testes usam
    monkeypatch.setenv). Sem AUTH_SECRET_KEY, cai no segredo público de dev
    e avisa uma única vez nos logs."""
    global _aviso_segredo_dado
    segredo = os.getenv("AUTH_SECRET_KEY", "").strip()
    if not segredo:
        if not _aviso_segredo_dado:
            logger.warning(
                "AUTH_SECRET_KEY não definida — usando segredo de "
                "DESENVOLVIMENTO. Defina a variável em produção."
            )
            _aviso_segredo_dado = True
        segredo = SEGREDO_DEV
    return segredo.encode("utf-8")


def _b64url(dados: bytes) -> str:
    return base64.urlsafe_b64encode(dados).decode("ascii").rstrip("=")


def _b64url_decode(texto: str) -> bytes:
    # Repõe o padding que o rstrip removeu.
    padding = "=" * (-len(texto) % 4)
    return base64.urlsafe_b64decode(texto + padding)


def gerar_token(usuario: dict, duracao_segundos: int = DURACAO_PADRAO_SEGUNDOS) -> str:
    """Cria o token de sessão assinado para o usuário (dict do store)."""
    payload = {
        "sub": str(usuario.get("usuario_id", "")),
        "nome": str(usuario.get("nome", "")),
        "email": str(usuario.get("email", "")),
        "tipo": str(usuario.get("tipo_usuario", "aluno")),
        "exp": int(time.time()) + int(duracao_segundos),
    }
    corpo = _b64url(
        json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
    )
    assinatura = _b64url(
        hmac.new(_segredo(), corpo.encode("ascii"), hashlib.sha256).digest()
    )
    return f"{corpo}.{assinatura}"


def validar_token(token: str) -> dict | None:
    """Devolve o payload se a assinatura for válida e o token não expirou.

    None em qualquer outro caso (lixo, assinatura errada, expirado) — quem
    chama decide o status HTTP (as rotas devolvem 401).
    """
    if not token or not isinstance(token, str) or "." not in token:
        return None

    corpo, _, assinatura = token.partition(".")
    try:
        esperada = _b64url(
            hmac.new(_segredo(), corpo.encode("ascii"), hashlib.sha256).digest()
        )
        if not hmac.compare_digest(esperada, assinatura):
            return None

        payload = json.loads(_b64url_decode(corpo))
        if not isinstance(payload, dict):
            return None
        if int(payload.get("exp", 0)) < time.time():
            return None
        if not payload.get("sub"):
            return None
        return payload
    except Exception:
        return None
