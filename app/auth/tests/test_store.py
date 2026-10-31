"""
Testes do store de usuários (app/auth/store.py) no backend JSON local.

O Supabase não é dublado aqui de propósito: sem credenciais no ambiente de
teste, `_cliente_supabase()` devolve None e o store cai no JSON local — que é
exatamente o caminho usado em dev (e o que precisa estar coberto). O arquivo
vai para um tmp_path via USERS_DB_PATH (lido a cada chamada, como no
local_store dos vídeos).
"""
from __future__ import annotations

import json

import pytest

from app.auth import store


@pytest.fixture(autouse=True)
def banco_local(monkeypatch, tmp_path):
    """Cada teste ganha um arquivo de contas vazio e isolado."""
    caminho = tmp_path / "usuarios.json"
    monkeypatch.setenv("USERS_DB_PATH", str(caminho))
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)
    return caminho


def _criar(nome="Maria Silva", email="maria@exemplo.com",
           tipo="aluno", senha_hash="pbkdf2_sha256$1$x$y"):
    return store.criar_usuario(
        nome=nome, email=email, senha_hash=senha_hash, tipo_usuario=tipo
    )


def test_criar_usuario_devolve_registro_completo():
    usuario = _criar()

    assert usuario is not None
    assert usuario["usuario_id"]
    assert usuario["nome"] == "Maria Silva"
    assert usuario["email"] == "maria@exemplo.com"
    assert usuario["tipo_usuario"] == "aluno"
    assert usuario["criado_em"]


def test_criar_usuario_persiste_no_arquivo_json(banco_local):
    _criar()

    conteudo = json.loads(banco_local.read_text(encoding="utf-8"))
    assert len(conteudo) == 1
    assert conteudo[0]["email"] == "maria@exemplo.com"


def test_email_duplicado_devolve_none():
    _criar()

    assert _criar(email="maria@exemplo.com") is None


def test_email_e_normalizado_para_minusculas():
    usuario = _criar(email="  Maria@Exemplo.COM ")

    assert usuario["email"] == "maria@exemplo.com"
    # ...e a duplicidade é detectada mesmo com caixa diferente.
    assert _criar(email="MARIA@exemplo.com") is None


def test_tipo_invalido_levanta_value_error():
    with pytest.raises(ValueError):
        _criar(tipo="diretor")


def test_professor_pode_ser_criado():
    usuario = _criar(tipo="professor")

    assert usuario["tipo_usuario"] == "professor"


def test_buscar_por_email_encontra_e_desconhecido_devolve_none():
    _criar()

    assert store.buscar_por_email("maria@exemplo.com")["nome"] == "Maria Silva"
    # Busca é case-insensitive (normaliza antes).
    assert store.buscar_por_email("MARIA@EXEMPLO.COM") is not None
    assert store.buscar_por_email("ninguem@exemplo.com") is None


def test_buscar_por_id_encontra_e_desconhecido_devolve_none():
    usuario = _criar()

    assert store.buscar_por_id(usuario["usuario_id"])["email"] == "maria@exemplo.com"
    assert store.buscar_por_id("uuid-que-nao-existe") is None


def test_listar_devolve_todas_as_contas():
    _criar()
    _criar(nome="João Prof", email="joao@exemplo.com", tipo="professor")

    assert len(store.listar()) == 2


def test_listar_filtra_por_tipo():
    _criar()
    _criar(nome="João Prof", email="joao@exemplo.com", tipo="professor")

    professores = store.listar(tipo_usuario="professor")
    assert len(professores) == 1
    assert professores[0]["email"] == "joao@exemplo.com"


def test_remover_segredos_tira_o_hash_da_senha():
    usuario = _criar()

    publico = store.remover_segredos(usuario)
    assert "senha_hash" not in publico
    assert publico["email"] == usuario["email"]
    # O registro original NÃO é mutado.
    assert "senha_hash" in usuario


def test_remover_segredos_de_none_devolve_none():
    assert store.remover_segredos(None) is None


def test_arquivo_corrompido_vira_banco_vazio_sem_levantar_erro(banco_local):
    banco_local.write_text("{ json inválido", encoding="utf-8")

    assert store.listar() == []
    assert store.buscar_por_email("maria@exemplo.com") is None
    # E uma criação nova reescreve o arquivo saudável.
    assert _criar() is not None
