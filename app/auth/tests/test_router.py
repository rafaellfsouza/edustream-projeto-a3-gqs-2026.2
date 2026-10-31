"""
Testes das rotas de autenticação (app/auth/router.py) via TestClient.

Cobrem o fluxo completo da feature:

    POST /auth/registrar → POST /auth/login → GET /auth/me
    POST /watch com Bearer → GET /recomendacoes/me (personalização real)
    GET /auth/usuarios (professor entra, aluno leva 403, anônimo 401)

O banco de usuários vai para tmp_path (USERS_DB_PATH) e as dependências de
recomendação (banco de vídeos + Redis) são dubladas no padrão dos testes
existentes do módulo — nenhum serviço externo é necessário.
"""
from __future__ import annotations

import copy

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.recommendations import router as modulo_rec


client = TestClient(app)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

@pytest.fixture(autouse=True)
def ambiente(monkeypatch, tmp_path):
    """Banco de contas isolado + segredo fixo, para todos os testes."""
    monkeypatch.setenv("USERS_DB_PATH", str(tmp_path / "usuarios.json"))
    monkeypatch.setenv("AUTH_SECRET_KEY", "segredo-dos-testes")
    monkeypatch.delenv("SUPABASE_URL", raising=False)
    monkeypatch.delenv("SUPABASE_KEY", raising=False)


def _registrar(nome="Maria Silva", email="maria@exemplo.com",
               senha="segredo123", tipo="aluno"):
    return client.post("/auth/registrar", json={
        "nome": nome, "email": email, "senha": senha, "tipo_usuario": tipo,
    })


def _auth_header(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


# ---------------------------------------------------------------------------
# POST /auth/registrar
# ---------------------------------------------------------------------------

def test_registrar_aluno_devolve_201_com_token():
    resposta = _registrar()

    assert resposta.status_code == 201
    corpo = resposta.json()
    assert corpo["token"]
    assert corpo["usuario"]["email"] == "maria@exemplo.com"
    assert corpo["usuario"]["tipo_usuario"] == "aluno"


def test_registrar_nao_vaza_o_hash_da_senha():
    corpo = _registrar().json()

    assert "senha_hash" not in corpo["usuario"]
    assert "segredo123" not in str(corpo)


def test_registrar_professor_guarda_o_tipo():
    corpo = _registrar(email="prof@exemplo.com", tipo="professor").json()

    assert corpo["usuario"]["tipo_usuario"] == "professor"


def test_registrar_email_duplicado_devolve_409():
    _registrar()

    assert _registrar(nome="Outra Maria").status_code == 409


def test_registrar_valida_campos():
    assert _registrar(nome="Mi").status_code == 422          # nome curto
    assert _registrar(email="sem-arroba").status_code == 422  # e-mail inválido
    assert _registrar(senha="123").status_code == 422         # senha curta
    assert _registrar(tipo="diretor").status_code == 422      # tipo inválido


def test_registrar_tipo_padrao_e_aluno():
    resposta = client.post("/auth/registrar", json={
        "nome": "João Padrão", "email": "joao@exemplo.com", "senha": "segredo123",
    })

    assert resposta.json()["usuario"]["tipo_usuario"] == "aluno"


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------

def test_login_com_credenciais_corretas_devolve_token():
    _registrar()

    resposta = client.post("/auth/login", json={
        "email": "maria@exemplo.com", "senha": "segredo123",
    })

    assert resposta.status_code == 200
    assert resposta.json()["token"]


def test_login_aceita_email_em_caixa_alta():
    _registrar()

    resposta = client.post("/auth/login", json={
        "email": "MARIA@Exemplo.com", "senha": "segredo123",
    })

    assert resposta.status_code == 200


def test_login_com_senha_errada_devolve_401():
    _registrar()

    resposta = client.post("/auth/login", json={
        "email": "maria@exemplo.com", "senha": "senha-errada",
    })

    assert resposta.status_code == 401


def test_login_de_email_inexistente_devolve_401_com_a_mesma_mensagem():
    _registrar()
    senha_errada = client.post("/auth/login", json={
        "email": "maria@exemplo.com", "senha": "senha-errada",
    }).json()["detail"]
    inexistente = client.post("/auth/login", json={
        "email": "ninguem@exemplo.com", "senha": "qualquer1",
    }).json()["detail"]

    # A resposta não pode permitir enumeração de e-mails cadastrados.
    assert senha_errada == inexistente


# ---------------------------------------------------------------------------
# GET /auth/me
# ---------------------------------------------------------------------------

def test_me_com_token_devolve_o_usuario_logado():
    token = _registrar().json()["token"]

    resposta = client.get("/auth/me", headers=_auth_header(token))

    assert resposta.status_code == 200
    assert resposta.json()["usuario"]["email"] == "maria@exemplo.com"


def test_me_sem_token_devolve_401():
    assert client.get("/auth/me").status_code == 401


def test_me_com_token_adulterado_devolve_401():
    token = _registrar().json()["token"]

    assert client.get("/auth/me", headers=_auth_header(token + "x")).status_code == 401


# ---------------------------------------------------------------------------
# GET /auth/usuarios — área do professor
# ---------------------------------------------------------------------------

def test_usuarios_listado_por_professor():
    token_prof = _registrar(email="prof@exemplo.com", tipo="professor").json()["token"]
    _registrar(email="aluno@exemplo.com")

    resposta = client.get("/auth/usuarios", headers=_auth_header(token_prof))

    assert resposta.status_code == 200
    corpo = resposta.json()
    assert corpo["total"] == 2
    emails = {item["email"] for item in corpo["usuarios"]}
    assert emails == {"prof@exemplo.com", "aluno@exemplo.com"}
    assert all("senha_hash" not in item for item in corpo["usuarios"])


def test_usuarios_negado_para_aluno():
    token_aluno = _registrar().json()["token"]

    assert client.get("/auth/usuarios",
                      headers=_auth_header(token_aluno)).status_code == 403


def test_usuarios_negado_para_anonimo():
    assert client.get("/auth/usuarios").status_code == 401


# ---------------------------------------------------------------------------
# Integração com as recomendações: /watch + /recomendacoes/me
# ---------------------------------------------------------------------------

def _video(video_id: str, titulo: str, tags) -> dict:
    return {
        "video_id": video_id,
        "titulo": titulo,
        "descricao": "descrição padrão",
        "tags": tags,
        "categoria": "Matemática",
        "autor": "Rafael",
        "criado_em": "2026-01-01T00:00:00+00:00",
        "status": "completed",
    }


CATALOGO = [
    _video("v-fra", "Frações", ["matemática", "frações"]),
    _video("v-geo", "Geometria", ["matemática", "geometria"]),
    _video("v-his", "História do Brasil", ["história", "brasil"]),
]


class ViewsFake:
    """Dublê do views_store (mesmo padrão dos testes de recomendação)."""

    def __init__(self) -> None:
        self.historicos: dict[str, list[str]] = {}
        self.registros: list[tuple[str, str | None]] = []

    def registrar_visualizacao(self, video_id, user_id=None):
        self.registros.append((video_id, user_id))
        historico = self.historicos.setdefault(user_id or "", [])
        if video_id in historico:
            historico.remove(video_id)
        historico.insert(0, video_id)
        return len(historico)

    def historico_do_usuario(self, user_id):
        return list(self.historicos.get(user_id, []))

    def contar_visualizacoes(self, video_id):
        return 0

    def mais_assistidos(self, limite=10):
        return []


@pytest.fixture
def recomendacoes_dubladas(monkeypatch):
    """Banco de vídeos fixo + Redis fake no router de recomendações."""
    estado = {
        "videos": {item["video_id"]: copy.deepcopy(item) for item in CATALOGO},
    }
    views = ViewsFake()

    monkeypatch.setattr(modulo_rec, "buscar_video",
                        lambda video_id: estado["videos"].get(video_id))
    monkeypatch.setattr(modulo_rec, "listar_videos",
                        lambda status=None: list(estado["videos"].values()))
    monkeypatch.setattr(modulo_rec, "views_store", views)
    return views


def test_watch_com_token_atribui_a_view_ao_usuario_logado(recomendacoes_dubladas):
    token = _registrar().json()["token"]
    usuario_id = client.get("/auth/me", headers=_auth_header(token)).json()["usuario"]["usuario_id"]

    resposta = client.post("/watch",
                           json={"video_id": "v-fra"},
                           headers=_auth_header(token))

    assert resposta.status_code == 200
    assert resposta.json()["user_id"] == usuario_id
    assert recomendacoes_dubladas.registros == [("v-fra", usuario_id)]


def test_watch_com_token_ignora_user_id_do_corpo(recomendacoes_dubladas):
    """O token vence o corpo: ninguém infla o histórico de outro usuário."""
    token = _registrar().json()["token"]
    usuario_id = client.get("/auth/me", headers=_auth_header(token)).json()["usuario"]["usuario_id"]

    client.post("/watch",
                json={"video_id": "v-fra", "user_id": "outra-pessoa"},
                headers=_auth_header(token))

    assert recomendacoes_dubladas.registros == [("v-fra", usuario_id)]


def test_watch_sem_token_mantem_o_comportamento_antigo(recomendacoes_dubladas):
    resposta = client.post("/watch", json={"video_id": "v-fra", "user_id": "demo-user"})

    assert resposta.status_code == 200
    assert recomendacoes_dubladas.registros == [("v-fra", "demo-user")]


def test_fluxo_completo_assistir_e_receber_recomendacoes_pessoais(
    recomendacoes_dubladas,
):
    """O coração da feature: login → assiste → recomendação personalizada.

    Maria assiste "Frações" (matemática). /recomendacoes/me tem que sugerir
    "Geometria" (compartilha a tag) e nunca o vídeo já assistido.
    """
    token = _registrar().json()["token"]

    client.post("/watch", json={"video_id": "v-fra"}, headers=_auth_header(token))
    resposta = client.get("/recomendacoes/me", headers=_auth_header(token))

    assert resposta.status_code == 200
    corpo = resposta.json()
    titulos = [item["titulo"] for item in corpo["recomendacoes"]]
    assert titulos == ["Geometria"]
    assert corpo["user_id"]


def test_recomendacoes_me_sem_login_devolve_401():
    assert client.get("/recomendacoes/me").status_code == 401


def test_recomendacoes_de_dois_usuarios_sao_independentes(recomendacoes_dubladas):
    token_maria = _registrar().json()["token"]
    token_joao = _registrar(nome="João História", email="joao@exemplo.com").json()["token"]

    client.post("/watch", json={"video_id": "v-fra"}, headers=_auth_header(token_maria))
    client.post("/watch", json={"video_id": "v-his"}, headers=_auth_header(token_joao))

    maria = client.get("/recomendacoes/me", headers=_auth_header(token_maria)).json()
    joao = client.get("/recomendacoes/me", headers=_auth_header(token_joao)).json()

    assert [item["titulo"] for item in maria["recomendacoes"]] == ["Geometria"]
    # João só assistiu história — nada no catálogo compartilha essas tags.
    assert joao["recomendacoes"] == []
    assert maria["user_id"] != joao["user_id"]
