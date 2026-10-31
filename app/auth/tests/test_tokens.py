"""
Testes do token de sessão (app/auth/tokens.py).

O token é stateless: tudo que a rota precisa saber vem no payload assinado.
Os casos que importam:

  * ida e volta — gerar → validar devolve a identidade;
  * expiração — token vencido é recusado;
  * adulteração — mudar o payload OU assinar com outro segredo invalida;
  * lixo — strings aleatórias devolvem None, nunca exceção.
"""
from __future__ import annotations

import time

import pytest

from app.auth import tokens


USUARIO = {
    "usuario_id": "u-123",
    "nome": "Maria Silva",
    "email": "maria@exemplo.com",
    "tipo_usuario": "professor",
}


@pytest.fixture(autouse=True)
def segredo_fixo(monkeypatch):
    """Segredo determinístico — sem depender do ambiente de quem roda."""
    monkeypatch.setenv("AUTH_SECRET_KEY", "segredo-dos-testes")


def test_gerar_e_validar_devolve_a_identidade():
    token = tokens.gerar_token(USUARIO)

    payload = tokens.validar_token(token)
    assert payload is not None
    assert payload["sub"] == "u-123"
    assert payload["nome"] == "Maria Silva"
    assert payload["email"] == "maria@exemplo.com"
    assert payload["tipo"] == "professor"
    assert payload["exp"] > time.time()


def test_token_vencido_e_recusado():
    token = tokens.gerar_token(USUARIO, duracao_segundos=-10)

    assert tokens.validar_token(token) is None


def test_payload_adulterado_invalida_a_assinatura():
    token = tokens.gerar_token(USUARIO)
    corpo, _, assinatura = token.partition(".")

    adulterado = corpo[:-2] + "xx"  # mexe no base64 do payload
    assert tokens.validar_token(f"{adulterado}.{assinatura}") is None


def test_segredo_diferente_invalida_o_token(monkeypatch):
    token = tokens.gerar_token(USUARIO)

    monkeypatch.setenv("AUTH_SECRET_KEY", "outro-segredo-completamente-diferente")
    assert tokens.validar_token(token) is None


@pytest.mark.parametrize("lixo", [
    None, "", "abc", "a.b", "a.b.c", "....", "Bearer x", 123, object(),
])
def test_lixo_devolve_none_sem_levantar_excecao(lixo):
    assert tokens.validar_token(lixo) is None


def test_sem_segredo_no_ambiente_usa_fallback_de_dev(monkeypatch):
    """Dev sem .env não pode quebrar: há um segredo público de fallback."""
    monkeypatch.delenv("AUTH_SECRET_KEY", raising=False)

    token = tokens.gerar_token(USUARIO)
    assert tokens.validar_token(token) is not None
