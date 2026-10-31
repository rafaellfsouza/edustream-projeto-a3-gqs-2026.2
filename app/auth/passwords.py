"""
Hash de senhas — PBKDF2-HMAC-SHA256 (100% biblioteca padrão).

Regras que este módulo garante:

  1. A senha NUNCA é guardada em texto claro. O banco (Supabase ou o JSON
     local) armazena apenas o hash com sal: `pbkdf2_sha256$iterações$sal$hash`.
  2. Cada senha tem um sal ALEATÓRIO próprio — duas contas com a mesma senha
     geram hashes diferentes (impede ataque com tabela rainbow).
  3. A comparação é em tempo constante (`hmac.compare_digest`), para não
     vazar informação pelo tempo de resposta.
  4. O número de iterações fica gravado no próprio hash: se um dia o time
     aumentar o custo, os hashes antigos continuam validando.

Por que PBKDF2 e não bcrypt/argon2? Porque são bibliotecas externas — este
módulo mantém a regra do projeto de zero dependências novas (o OpenSSL por
trás do `hashlib.pbkdf2_hmac` já é rápido e auditado).
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import os

ALGORITMO = "pbkdf2_sha256"

# Custo do hash. 200 mil iterações ≈ dezenas de milissegundos por login —
# imperceptível para o usuário, caro demais para força bruta em massa.
# Em produção séria considere subir (OWASP recomenda ≥ 600 mil para SHA-256);
# aqui o valor equilibra segurança e a velocidade da suíte de testes.
ITERACOES = 200_000

TAMANHO_SAL_BYTES = 16


def hash_senha(senha: str) -> str:
    """Gera o hash armazenável da senha: `algoritmo$iterações$sal$digest`."""
    if not isinstance(senha, str) or not senha:
        raise ValueError("senha deve ser uma string não vazia")

    sal = os.urandom(TAMANHO_SAL_BYTES)
    digest = hashlib.pbkdf2_hmac(
        "sha256", senha.encode("utf-8"), sal, ITERACOES
    )
    return "$".join([
        ALGORITMO,
        str(ITERACOES),
        base64.b64encode(sal).decode("ascii"),
        base64.b64encode(digest).decode("ascii"),
    ])


def verificar_senha(senha: str, hash_armazenado: str) -> bool:
    """Confere a senha digitada contra o hash do banco.

    Devolve False (nunca levanta exceção) para qualquer entrada malformada —
    hash corrompido no banco não pode virar erro 500 na rota de login.
    """
    try:
        algoritmo, iteracoes, sal_b64, digest_b64 = hash_armazenado.split("$")
        if algoritmo != ALGORITMO:
            return False

        sal = base64.b64decode(sal_b64)
        esperado = base64.b64decode(digest_b64)
        calculado = hashlib.pbkdf2_hmac(
            "sha256", senha.encode("utf-8"), sal, int(iteracoes)
        )
        return hmac.compare_digest(calculado, esperado)
    except Exception:
        return False
