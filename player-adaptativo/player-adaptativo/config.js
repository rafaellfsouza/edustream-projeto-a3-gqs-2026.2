/**
 * Configuração do player — carregada ANTES dos módulos (index.html/home.html).
 *
 * Tudo aqui é opcional: se este arquivo não definir nada, o player descobre a
 * API sozinho e pega o catálogo do banco via GET /catalogo.
 *
 * ⚠️  Não coloque URL de vídeo aqui. O catálogo vem do BANCO DE DADOS
 * (Supabase, ou data/videos.json em dev) — é o backend que devolve o
 * `hls_url` de cada vídeo (videos/{video_id}/master.m3u8). URL fixa no JS só
 * servia para testar o player isolado e era a causa de "só toca o vídeo que
 * tem URL no código".
 *
 * Este arquivo fica versionado de propósito (não guarda segredo nenhum).
 * Ajuste local que você NÃO quer commitar: crie um `config.local.js` ao lado
 * dele, defina `window.PLAYER_CONFIG` lá e acrescente a tag <script> no HTML
 * ANTES do config.js — ou simplesmente use a query string da watch page
 * (`index.html?video={uuid}`), que não exige editar nada.
 */
window.PLAYER_CONFIG = window.PLAYER_CONFIG || {};

(function () {
  const config = window.PLAYER_CONFIG;

  // ---------------------------------------------------------------------
  // Origem da API (backend FastAPI).
  //
  //  * Servido pelo próprio backend (http://localhost:8000/player/) → usa a
  //    MESMA origem. É o cenário recomendado no README: zero CORS, zero
  //    configuração, e funciona em qualquer host/porta que você usar.
  //  * Servido por outro servidor (Live Server :5500, http.server, etc.) →
  //    cai no backend padrão em localhost:8000 (a API tem CORS liberado).
  // ---------------------------------------------------------------------
  const servidoPeloBackend = window.location.protocol.startsWith("http") &&
    (window.location.pathname.startsWith("/player") ||
      window.location.port === "8000");

  config.API_BASE_URL =
    config.API_BASE_URL ||
    (servidoPeloBackend ? window.location.origin : "http://localhost:8000");

  // ---------------------------------------------------------------------
  // Quem assiste (alimenta POST /watch → /trending e /recomendacoes).
  // Este é o usuário ANÔNIMO de fallback: com a autenticação ativa
  // (login.html), js/auth.js assume — o id do usuário logado tem prioridade
  // sobre este valor no POST /watch e nas recomendações pessoais.
  // ---------------------------------------------------------------------
  config.USER_ID = config.USER_ID || "demo-user";

  // ---------------------------------------------------------------------
  // Overrides de DESENVOLVIMENTO (opcionais, deixe comentado).
  //
  // HLS_URL força uma playlist específica e DESLIGA a auto-seleção do
  // catálogo — use só para testar o player isolado do backend:
  //   config.HLS_URL = "https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8";
  //
  // VIDEO_ID abre a watch page num vídeo específico (equivale a
  // index.html?video=VIDEO_ID):
  //   config.VIDEO_ID = "uuid-do-video";
  // ---------------------------------------------------------------------
})();
