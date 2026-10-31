"""
Contador de visualizações e histórico do usuário — em Redis.

Por que Redis e não Supabase?
  * O projeto já sobe Redis no docker-compose (é o broker do Celery), então não
    adiciona infraestrutura nova.
  * Contagem de view é escrita frequente e de baixo valor unitário — exatamente
    o caso de uso de um contador em memória.
  * Evita migração de banco: não existe tabela `visualizacoes` no Supabase e o
    `/trending` precisa funcionar no dia da apresentação.

Segue o mesmo padrão do `app/queue/status_store.py` (mesmo prefixo de chave,
mesmo cliente, mesmas funções pequenas) para o time não aprender duas APIs.

Chaves usadas:
    video_views:ranking        ZSET  video_id -> quantidade de views
    video_views:total:{id}     STR   contador individual
    video_views:historico:{user}  LIST  video_ids assistidos, mais recente 1º

Fallback SEM Redis (novidade da feature de autenticação):
    O histórico por usuário é o insumo das recomendações pessoais — sem ele,
    o login não teria efeito visível. Quando o Redis está fora do ar (dev no
    Windows sem Docker, sandbox de demonstração), as quatro funções caem num
    armazenamento em memória do próprio processo: a plataforma continua
    recomendando de ponta a ponta, com a limitação óbvia de que o estado se
    perde ao reiniciar a API. Com Redis no ar, nada muda.

    Os testes existentes não são afetados: eles dublam `_redis_client` com um
    FakeRedis que NUNCA levanta erro, então o caminho do fallback não dispara.
"""
from __future__ import annotations

import logging
import os
import threading

import redis

logger = logging.getLogger(__name__)

VIEWS_REDIS_URL = os.getenv("CELERY_RESULT_BACKEND", "redis://localhost:6379/1")

_redis_client = redis.Redis.from_url(VIEWS_REDIS_URL, decode_responses=True)

RANKING_KEY = "video_views:ranking"
TOTAL_KEY_PREFIX = "video_views:total:"
HISTORICO_KEY_PREFIX = "video_views:historico:"

# Limite do histórico por usuário: suficiente para recomendar sem crescer sem fim.
TAMANHO_HISTORICO = 20

# ---------------------------------------------------------------------------
# Fallback em memória (usado SOMENTE quando o Redis levanta RedisError).
# ---------------------------------------------------------------------------
_mem_lock = threading.Lock()
_mem_totais: dict[str, int] = {}
_mem_ranking: dict[str, int] = {}
_mem_historicos: dict[str, list[str]] = {}

_aviso_redis_fora_dado = False


def _avisar_redis_fora(exc: Exception) -> None:
    """Loga uma única vez que o Redis está indisponível (sem spam de log)."""
    global _aviso_redis_fora_dado
    if not _aviso_redis_fora_dado:
        logger.warning(
            "Redis indisponível (%s) — contagem de views e histórico em "
            "MEMÓRIA no processo da API (estado se perde ao reiniciar).",
            exc,
        )
        _aviso_redis_fora_dado = True


def registrar_visualizacao(video_id: str, user_id: str | None = None) -> int:
    """Conta +1 view no vídeo e, se houver usuário, guarda no histórico dele.

    Returns:
        O novo total de visualizações do vídeo.
    """
    try:
        total = _redis_client.incr(f"{TOTAL_KEY_PREFIX}{video_id}")
        _redis_client.zincrby(RANKING_KEY, 1, video_id)

        if user_id:
            chave = f"{HISTORICO_KEY_PREFIX}{user_id}"
            # Remove antes de inserir: assistir de novo não pode duplicar no
            # histórico, senão o mesmo vídeo domina as recomendações do usuário.
            _redis_client.lrem(chave, 0, video_id)
            _redis_client.lpush(chave, video_id)
            _redis_client.ltrim(chave, 0, TAMANHO_HISTORICO - 1)

        return int(total)
    except redis.exceptions.RedisError as exc:
        _avisar_redis_fora(exc)
        return _registrar_em_memoria(video_id, user_id)


def _registrar_em_memoria(video_id: str, user_id: str | None) -> int:
    with _mem_lock:
        _mem_totais[video_id] = _mem_totais.get(video_id, 0) + 1
        _mem_ranking[video_id] = _mem_ranking.get(video_id, 0) + 1

        if user_id:
            historico = _mem_historicos.setdefault(user_id, [])
            if video_id in historico:
                historico.remove(video_id)
            historico.insert(0, video_id)
            del historico[TAMANHO_HISTORICO:]

        return _mem_totais[video_id]


def contar_visualizacoes(video_id: str) -> int:
    """Total de views de um vídeo (0 se nunca foi assistido)."""
    try:
        valor = _redis_client.get(f"{TOTAL_KEY_PREFIX}{video_id}")
        return int(valor) if valor else 0
    except redis.exceptions.RedisError as exc:
        _avisar_redis_fora(exc)
        with _mem_lock:
            return _mem_totais.get(video_id, 0)


def mais_assistidos(limite: int = 10) -> list[tuple[str, int]]:
    """Ranking de vídeos por visualizações, do mais assistido para o menos.

    Returns:
        Lista de tuplas `(video_id, views)`.
    """
    if limite <= 0:
        return []

    try:
        brutos = _redis_client.zrevrange(RANKING_KEY, 0, limite - 1, withscores=True)
        return [(video_id, int(pontuacao)) for video_id, pontuacao in brutos]
    except redis.exceptions.RedisError as exc:
        _avisar_redis_fora(exc)
        with _mem_lock:
            ordenado = sorted(
                _mem_ranking.items(), key=lambda item: (-item[1], item[0])
            )
            return ordenado[:limite]


def historico_do_usuario(user_id: str) -> list[str]:
    """video_ids assistidos pelo usuário, do mais recente para o mais antigo."""
    try:
        return _redis_client.lrange(f"{HISTORICO_KEY_PREFIX}{user_id}", 0, -1)
    except redis.exceptions.RedisError as exc:
        _avisar_redis_fora(exc)
        with _mem_lock:
            return list(_mem_historicos.get(user_id, []))
