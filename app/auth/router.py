"""
Rotas de autenticação — /auth/*.

    POST /auth/registrar   cria conta (aluno ou professor) e já devolve token
    POST /auth/login       valida e-mail + senha e devolve token
    GET  /auth/me          dados do usuário logado (requer Bearer)
    GET  /auth/usuarios    lista as contas da plataforma (SÓ professor)

Contratos de resposta:

    {"usuario": {usuario_id, nome, email, tipo_usuario, criado_em},
     "token":   "<assinado>"}          — o `senha_hash` NUNCA sai do store.

Erros:
    409  e-mail já cadastrado
    401  credenciais inválidas / sem token / token vencido
    403  aluno tentando acessar área de professor
    422  validação de campos (pydantic)
    503  banco indisponível (Supabase sem credenciais E JSON local inacessível)

Decisão de UX/segurança: login com e-mail inexistente e login com senha
errada devolvem A MESMA mensagem (401) — não damos a um estranho a
confirmação de que um e-mail está cadastrado na plataforma.
"""
from __future__ import annotations

import logging
import re

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.auth import store
from app.auth.dependencies import exigir_professor, usuario_atual
from app.auth.passwords import hash_senha, verificar_senha
from app.auth.tokens import gerar_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["autenticacao"])

# Validação simples de e-mail, sem dependência externa (email-validator):
# para o cadastro da plataforma educacional, "tem um @ com domínio" basta.
REGEX_EMAIL = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class RegistroRequest(BaseModel):
    """Corpo do POST /auth/registrar."""

    nome: str = Field(min_length=3, max_length=80, description="Nome completo")
    email: str = Field(min_length=5, max_length=160)
    senha: str = Field(min_length=6, max_length=72)
    tipo_usuario: str = Field(
        default="aluno",
        description="Perfil da conta: 'aluno' (padrão) ou 'professor'",
    )

    @field_validator("email")
    @classmethod
    def email_valido(cls, valor: str) -> str:
        valor = store.normalizar_email(valor)
        if not REGEX_EMAIL.match(valor):
            raise ValueError("e-mail inválido — use o formato nome@dominio.com")
        return valor

    @field_validator("tipo_usuario")
    @classmethod
    def tipo_conhecido(cls, valor: str) -> str:
        valor = str(valor or "").strip().lower()
        if valor not in store.TIPOS_USUARIO:
            raise ValueError(
                f"tipo_usuario deve ser um de {list(store.TIPOS_USUARIO)}"
            )
        return valor

    @field_validator("nome")
    @classmethod
    def nome_sem_aparas(cls, valor: str) -> str:
        return str(valor).strip()


class LoginRequest(BaseModel):
    """Corpo do POST /auth/login."""

    email: str = Field(min_length=5, max_length=160)
    senha: str = Field(min_length=1, max_length=72)

    @field_validator("email")
    @classmethod
    def email_normalizado(cls, valor: str) -> str:
        return store.normalizar_email(valor)


def _resposta_de_sessao(usuario: dict) -> dict:
    """Monta o par {usuario público, token} devolvido por registrar/login."""
    return {
        "usuario": store.remover_segredos(usuario),
        "token": gerar_token(usuario),
    }


def _executar_no_banco(operacao, *args, **kwargs):
    """Mesma política de erro das rotas de recomendação: falha de banco vira
    503 com mensagem legível, nunca 500 com stacktrace."""
    try:
        return operacao(*args, **kwargs)
    except HTTPException:
        raise
    except ValueError as exc:  # tipo_usuario inválido vindo do store
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # rede fora, tabela ausente, disco sem permissão
        logger.exception("Falha inesperada no banco de usuários")
        raise HTTPException(
            status_code=503, detail=f"Falha ao acessar o banco de usuários: {exc}"
        ) from exc


@router.post("/registrar", status_code=201)
def registrar(payload: RegistroRequest):
    """Cria a conta (aluno/professor) e já devolve a sessão iniciada."""
    senha_hash = hash_senha(payload.senha)

    usuario = _executar_no_banco(
        store.criar_usuario,
        nome=payload.nome,
        email=payload.email,
        senha_hash=senha_hash,
        tipo_usuario=payload.tipo_usuario,
    )
    if usuario is None:
        raise HTTPException(
            status_code=409,
            detail="Já existe uma conta com este e-mail. Faça login.",
        )

    logger.info(
        "Conta criada: %s (%s)", usuario.get("email"), usuario.get("tipo_usuario")
    )
    return _resposta_de_sessao(usuario)


@router.post("/login")
def login(payload: LoginRequest):
    """Valida credenciais e devolve o token de sessão."""
    usuario = _executar_no_banco(store.buscar_por_email, payload.email)

    # E-mail desconhecido e senha errada → a MESMA resposta (não revela quais
    # e-mails estão cadastrados).
    if usuario is None or not verificar_senha(payload.senha, usuario.get("senha_hash", "")):
        raise HTTPException(
            status_code=401, detail="E-mail ou senha incorretos."
        )

    return _resposta_de_sessao(usuario)


@router.get("/me")
def me(usuario: dict = Depends(usuario_atual)):
    """Identidade da sessão atual — o front usa para montar o menu de perfil."""
    return {"usuario": usuario}


@router.get("/usuarios")
def listar_usuarios(usuario: dict = Depends(exigir_professor)):
    """Área do professor: contas cadastradas na plataforma (sem hashes)."""
    usuarios = _executar_no_banco(store.listar)
    return {
        "usuarios": [store.remover_segredos(item) for item in usuarios],
        "total": len(usuarios),
    }
