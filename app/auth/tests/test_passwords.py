"""
Testes do hash de senha (app/auth/passwords.py).

O que precisa ser garantido:
  * a mesma senha verifica contra o próprio hash (ida e volta);
  * senha errada NÃO verifica;
  * sais diferentes → hashes diferentes para a mesma senha (anti-rainbow);
  * hash corrompido devolve False em vez de levantar exceção (login não 500).
"""
from __future__ import annotations

from app.auth.passwords import ALGORITMO, hash_senha, verificar_senha


def test_hash_comeca_com_o_algoritmo_e_tem_quatro_partes():
    resultado = hash_senha("segredo123")

    partes = resultado.split("$")
    assert partes[0] == ALGORITMO
    assert len(partes) == 4


def test_mesma_senha_verifica_contra_o_proprio_hash():
    assert verificar_senha("segredo123", hash_senha("segredo123")) is True


def test_senha_errada_nao_verifica():
    assert verificar_senha("errada999", hash_senha("segredo123")) is False


def test_dois_hashes_da_mesma_senha_sao_diferentes_sal_aleatorio():
    primeiro = hash_senha("segredo123")
    segundo = hash_senha("segredo123")

    assert primeiro != segundo
    # ...mas ambos continuam verificando contra a senha original.
    assert verificar_senha("segredo123", primeiro)
    assert verificar_senha("segredo123", segundo)


def test_a_senha_nao_aparece_em_texto_claro_no_hash():
    assert "segredo123" not in hash_senha("segredo123")


def test_hash_corrompido_devolve_false_sem_levantar_excecao():
    assert verificar_senha("qualquer", "hash-quebrado") is False
    assert verificar_senha("qualquer", "") is False
    assert verificar_senha("qualquer", "pbkdf2_sha256$x$y$z") is False


def test_algoritmo_desconhecido_devolve_false():
    assert verificar_senha("segredo123", "bcrypt$10$aaa$bbb") is False


def test_senha_vazia_levanta_value_error_no_hash():
    try:
        hash_senha("")
        assert False, "deveria levantar ValueError"
    except ValueError:
        pass


def test_unicode_funciona():
    assert verificar_senha("senha-çãõ-é🔐", hash_senha("senha-çãõ-é🔐")) is True
