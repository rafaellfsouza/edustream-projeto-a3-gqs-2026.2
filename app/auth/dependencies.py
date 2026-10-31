"""
Dependências FastAPI do módulo de autenticação.

Transformam o cabeçalho `Authorization: Bearer <token>` no dict do usuário
logado, para qualquer rota poder exigir (ou não) uma sessão:

    @router.get("/restrita")
    def rota(usuario: dict = Depends(usuario_atual)):        # 401 sem token
        ...

    @router.get("/so-professor")
    def rota(usuario: dict = Depends(exigir_professor)):     # 403 se aluno
        ...

    usuario = usuario_atual_opcional(request)                # None se anônimo

Decisão: a identidade vem do PRÓPRIO token (assinado + com expiração) — sem
consulta ao banco por requisição. Para o porte do projeto isso é suficiente;
se um dia houver "revogar sessão", o store ganha uma lista negra de tokens.
"""
from __future__ import annotations

from fastapi import Depends, HTTPException, Request

from app.auth.tokens import validar_token


def extrair_token(request: Request) -> str | None:
    """Token do cabeçalho `Authorization: Bearer <token>` (None se ausente)."""
    cabecalho = request.headers.get("Authorization") or ""
    if not cabecalho.lower().startswith("bearer "):
        return None
    token = cabecalho[len("bearer "):].strip()
    return token or None


def usuario_atual_opcional(request: Request) -> dict | None:
    """Usuário do token válido, ou None (anônimo / token inválido / vencido).

    Nunca levanta exceção: rotas públicas (catálogo, /watch anônimo) usam esta
    função para ENRIQUECER a resposta quando há sessão, sem exigir login.
    """
    token = extrair_token(request)
    if not token:
        return None

    payload = validar_token(token)
    if payload is None:
        return None

    return {
        "usuario_id": payload.get("sub"),
        "nome": payload.get("nome", ""),
        "email": payload.get("email", ""),
        "tipo_usuario": payload.get("tipo", "aluno"),
    }


def usuario_atual(
    usuario: dict | None = Depends(usuario_atual_opcional),
) -> dict:
    """Exige sessão válida — sem token (ou token inválido) devolve 401."""
    if usuario is None:
        raise HTTPException(
            status_code=401,
            detail="Autenticação necessária — faça login para continuar.",
            headers={"WWW-Authenticate": "Bearer"},
        )
    return usuario


def exigir_professor(usuario: dict = Depends(usuario_atual)) -> dict:
    """Exige sessão de PROFESSOR — aluno autenticado recebe 403."""
    if usuario.get("tipo_usuario") != "professor":
        raise HTTPException(
            status_code=403,
            detail="Esta área é exclusiva para professores.",
        )
    return usuario
