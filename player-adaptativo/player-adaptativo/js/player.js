/**
 * Player da watch page (index.html).
 *
 * DE ONDE VEM O VÍDEO (nesta ordem)
 * --------------------------------
 *  1. `?video={id}` na URL        — é como a home (home.html) abre um vídeo;
 *  2. `PLAYER_CONFIG.VIDEO_ID`    — override de desenvolvimento (config.js);
 *  3. `PLAYER_CONFIG.HLS_URL`     — playlist forçada (só para testar o player
 *                                    isolado do backend);
 *  4. o primeiro vídeo do CATÁLOGO — GET /trending + GET /videos/{id}/relacionados.
 *
 * Em todos os casos a URL do stream (master.m3u8) vem DO BANCO, devolvida pela
 * API no campo `hls_url` (a API monta `videos/{video_id}/master.m3u8` e ainda
 * diz, em `media_pronta`, se o arquivo existe no disco). Não há mais URL de
 * vídeo escrita neste arquivo — era isso que fazia o player "só tocar o vídeo
 * que tem URL dentro do JS".
 *
 * QUANDO NÃO DÁ PLAY
 * ------------------
 * Em vez de ficar repetindo a mesma requisição num 404 (loop de retry), o
 * player diagnostica e explica: consulta GET /status/{id} e GET /media/{id} e
 * diz se o vídeo ainda está transcodificando, se o processamento falhou ou se
 * os arquivos HLS não foram encontrados — com o que fazer em cada caso.
 */
import { PlayerControls } from "./controls.js";
import { QualityManager } from "./quality.js";
import {
  renderRecommendations,
  renderSidebar
} from "./recommendations.js";
import {
  atualizarCatalogoDaApi,
  buscarVideoDaApi,
  formatarVisualizacoes,
  registrarVisualizacao,
  temStream
} from "./catalog.js";
import { API_BASE_URL, getMedia, getVideoStatus, resolveMediaUrl } from "./api.js";
import { definirParametro } from "./busca.js";
import { idUsuarioAtual, iniciarUiPerfil } from "./auth.js";

// index.html?video={id} — é assim que a home (home.html) abre um vídeo.
const PARAMS = new URLSearchParams(window.location.search);
const VIDEO_DA_URL = PARAMS.get("video");

const CONFIG = {
  // Overrides opcionais de desenvolvimento (config.js). Sem eles, o vídeo vem
  // do catálogo da API — que lê do banco (Supabase ou data/videos.json).
  HLS_URL: window.PLAYER_CONFIG?.HLS_URL || "",
  VIDEO_ID: window.PLAYER_CONFIG?.VIDEO_ID || VIDEO_DA_URL || "",
  // Identidade ANÔNIMA de fallback. Com login ativo (login.html), quem assina
  // o POST /watch é o usuário real — idUsuarioAtual() vence este valor.
  USER_ID: window.PLAYER_CONFIG?.USER_ID || "demo-user"
};

/** Quantas tentativas automáticas antes de desistir e explicar o problema. */
const MAX_TENTATIVAS_REDE = 3;
const INTERVALO_RETRY_MS = 3000;
/** Espera entre as consultas de /status enquanto o vídeo transcodifica. */
const INTERVALO_PROCESSANDO_MS = 5000;

const video = document.querySelector("#video");

const elements = {
  playerShell: document.querySelector("#playerShell"),
  playerLoading: document.querySelector("#playerLoading"),
  playerError: document.querySelector("#playerError"),
  playerErrorMessage: document.querySelector("#playerErrorMessage"),
  retryButton: document.querySelector("#retryButton"),
  connectionAlert: document.querySelector("#connectionAlert"),
  connectionMessage: document.querySelector("#connectionMessage"),
  reduceQualityButton: document.querySelector("#reduceQualityButton"),
  dismissQualityButton: document.querySelector("#dismissQualityButton"),
  playButton: document.querySelector("#playButton"),
  backButton: document.querySelector("#backButton"),
  muteButton: document.querySelector("#muteButton"),
  volume: document.querySelector("#volume"),
  progress: document.querySelector("#progress"),
  timeLabel: document.querySelector("#timeLabel"),
  settingsButton: document.querySelector("#settingsButton"),
  settingsMenu: document.querySelector("#settingsMenu"),
  closeSettingsButton: document.querySelector("#closeSettingsButton"),
  qualitySelect: document.querySelector("#qualitySelect"),
  speedSelect: document.querySelector("#speedSelect"),
  pipButton: document.querySelector("#pipButton"),
  fullscreenButton: document.querySelector("#fullscreenButton"),
  currentQuality: document.querySelector("#currentQuality"),
  relatedVideos: document.querySelector("#relatedVideos"),
  sidebarVideos: document.querySelector("#sidebarVideos"),
  recomendadosVideos: document.querySelector("#recomendadosVideos"),
  recomendadosTitle: document.querySelector("#recomendadosTitle"),
  videoTitle: document.querySelector("#videoTitle"),
  views: document.querySelector("#views"),
  date: document.querySelector("#date"),
  description: document.querySelector("#description")
};

let hls = null;
let qualityManager = null;
let controls = null;
let retryTimer = null;
let processandoTimer = null;

/** O que está em reprodução (ou a última tentativa) — usado pelo "tentar novamente". */
let fonteAtual = null;
let urlAtual = null;
let carregado = false;
let tentativasRede = 0;

try {
  initialize();
} catch (error) {
  // Sem isso, um erro de JS deixava a página com o spinner "Carregando vídeo..."
  // para sempre e nenhuma dica do que aconteceu (nem nos cards, nem no console).
  console.error("Falha ao iniciar o player:", error);
  showError(`Falha ao iniciar o player: ${error.message}`);
}

function initialize() {
  controls = new PlayerControls(video, elements);
  renderRecommendations(elements.relatedVideos);
  renderSidebar(elements.sidebarVideos);
  ligarBusca();
  iniciarUiPerfil();

  elements.qualitySelect.addEventListener("change", (event) => {
    try {
      qualityManager?.setQuality(event.target.value);
    } catch (error) {
      console.error(error);
    }
  });

  elements.reduceQualityButton.addEventListener("click", () => {
    qualityManager?.reduceQuality();
  });

  elements.dismissQualityButton.addEventListener("click", () => {
    qualityManager?.hideAlert();
  });

  elements.retryButton.addEventListener("click", () => {
    repetirUltimaFonte();
  });

  window.addEventListener("video-selected", (event) => {
    selecionarVideo(event.detail);
  });

  // `iniciar()` é assíncrono: qualquer rejeição precisa virar mensagem na tela
  // (e não um "Uncaught (in promise)" silencioso no console).
  iniciar().catch((error) => {
    console.error("Falha ao resolver o vídeo inicial:", error);
    showError(`Falha ao carregar o vídeo: ${error.message}`);
  });
}

/**
 * Decide qual vídeo tocar e carrega o catálogo (relacionados + em alta).
 *
 * Sem `?video=` e sem override, a ordem é: resolve o catálogo e toca o
 * primeiro vídeo que tem mídia pronta.
 */
async function iniciar() {
  // Checagem SÍNCRONA: se o navegador não toca HLS (e o vendor/hls.min.js não
  // carregou), o aviso aparece na hora — em vez de a página ficar no spinner
  // "Carregando vídeo..." enquanto consulta a API. O catálogo continua sendo
  // carregado (os cards são úteis mesmo assim); nenhuma URL é inventada.
  if (!navegadorSuportaHls()) {
    showError("Este navegador não suporta HLS.");
  }

  const override = CONFIG.HLS_URL || CONFIG.VIDEO_ID;

  if (override) {
    if (CONFIG.HLS_URL) {
      // Override de desenvolvimento: toca a playlist informada. O título só é
      // trocado se vier metadado real (senão a página manteria o texto padrão).
      loadVideo(resolveMediaUrl(CONFIG.HLS_URL), { id: CONFIG.VIDEO_ID });
    } else {
      await tocarVideoDoBanco(CONFIG.VIDEO_ID);
    }
    // Relacionados/em alta do vídeo em reprodução (não auto-seleciona outro).
    await carregarCatalogo(CONFIG.VIDEO_ID || VIDEO_DA_URL || "", { autoSelecionar: false });
    return;
  }

  await carregarCatalogo("", { autoSelecionar: true });
}

/** Busca o metadado no banco (GET /catalogo/{id}) e toca o stream dele. */
async function tocarVideoDoBanco(videoId) {
  const { video: item, motivo } = await buscarVideoDaApi(videoId);

  if (!item) {
    showError(mensagemVideoNaoEncontrado(videoId, motivo));
    return null;
  }

  if (!temStream(item)) {
    await diagnosticarSemMidia(item);
    return null;
  }

  loadVideo(resolveMediaUrl(item.hlsUrl), item);
  return item;
}

/**
 * Busca relacionados + em alta na API e redesenha os cards.
 *
 * Com `autoSelecionar`, o primeiro vídeo com mídia pronta vira o vídeo em
 * reprodução — é o que faz a página abrir tocando conteúdo DE VERDADE do
 * banco, sem nenhuma URL escrita no front.
 */
async function carregarCatalogo(videoId, { autoSelecionar = false } = {}) {
  let resultado = { relacionados: [], emAlta: [], recomendados: [], apiRespondeu: false };

  try {
    resultado = await atualizarCatalogoDaApi({
      relatedContainer: elements.relatedVideos,
      sidebarContainer: elements.sidebarVideos,
      recomendadosContainer: elements.recomendadosVideos,
      videoId
    });
  } catch (error) {
    console.info("Catálogo da API indisponível:", error);
  }

  // O bloco "Recomendados para você" só aparece quando há sessão com
  // histórico (login.html → POST /watch → GET /recomendacoes/{id}).
  if (elements.recomendadosTitle) {
    elements.recomendadosTitle.classList.toggle(
      "hidden",
      !(resultado.recomendados ?? []).length
    );
  }

  if (autoSelecionar) {
    const candidatos = [...resultado.emAlta, ...resultado.relacionados];
    await selecionarVideoInicial(candidatos, resultado.apiRespondeu);
  }

  return resultado;
}

/**
 * Toca o primeiro vídeo real do catálogo.
 *
 * Não faz nada quando a API não respondeu (backend fora do ar) — nesse caso o
 * player explica o que fazer em vez de tentar uma URL que não existe.
 */
async function selecionarVideoInicial(videos, apiRespondeu) {
  const candidatos = videos || [];
  const primeiro = candidatos.find((item) => temStream(item));

  if (primeiro) {
    CONFIG.VIDEO_ID = primeiro.id;
    loadVideo(resolveMediaUrl(primeiro.hlsUrl), primeiro);
    // O endereço passa a refletir o vídeo em reprodução (link compartilhável).
    atualizarUrlDaPagina(primeiro.id);
    return;
  }

  // Sem vídeo para tocar, o que impede a reprodução é o navegador: esse aviso
  // (já mostrado de forma síncrona no iniciar()) é mais útil do que falar do
  // catálogo. `erroVisivel()` evita sobrescrever a mensagem com um segundo
  // diagnóstico redundante.
  if (!navegadorSuportaHls()) {
    if (!erroVisivel()) showError("Este navegador não suporta HLS.");
    return;
  }

  if (!apiRespondeu) {
    showError(
      `Não foi possível consultar o catálogo: a API não respondeu em ${API_BASE_URL}. ` +
      "Suba o backend com `uvicorn app.main:app --reload` (ou `python scripts/subir_tudo.py`) " +
      "e recarregue a página."
    );
    return;
  }

  // O banco respondeu, mas nenhum dos vídeos listados tem master.m3u8 no
  // disco: em vez de tentar um 404 (era o loop de retry de antes), perguntamos
  // ao backend o estado do primeiro deles e explicamos o que falta.
  const semMidia = candidatos.find((item) => item?.id);
  if (semMidia) {
    await diagnosticarSemMidia(semMidia);
    return;
  }

  showError(mensagemCatalogoVazio());
}

/** O navegador toca HLS (nativo, como no Safari) ou temos o HLS.js carregado? */
function navegadorSuportaHls() {
  if (window.Hls && Hls.isSupported()) return true;
  return Boolean(video?.canPlayType?.("application/vnd.apple.mpegurl"));
}

function mensagemCatalogoVazio() {
  return (
    "Nenhum vídeo pronto para assistir ainda. Envie um vídeo pela home " +
    '(botão "Enviar vídeo") ou rode `python scripts/demo_completo.py` — ' +
    "assim que a transcodificação terminar o play é automático."
  );
}

/** Clique num card (relacionados, sidebar ou demonstração). */
async function selecionarVideo(selecionado) {
  if (!selecionado) return;

  if (!temStream(selecionado)) {
    // Nada de ficar mudo: o usuário clicou e precisa saber por que não tocou.
    if (selecionado.demo) {
      showError(
        "Vídeos de demonstração não têm stream (servem só de exemplo de layout). " +
        "O catálogo real vem do banco — abra a home para escolher um vídeo publicado."
      );
    } else if (selecionado.id) {
      await diagnosticarSemMidia(selecionado);
    } else {
      showError("Este vídeo não tem stream HLS disponível.");
    }
    return;
  }

  CONFIG.VIDEO_ID = selecionado.id;
  loadVideo(resolveMediaUrl(selecionado.hlsUrl), selecionado);
  atualizarUrlDaPagina(selecionado.id);

  // Os "relacionados" passam a ser os do vídeo recém-escolhido — é a conversa
  // com o backend: GET /videos/{novo_id}/relacionados.
  carregarCatalogo(selecionado.id, { autoSelecionar: false });
}

// ---------------------------------------------------------------------------
// Carga e reprodução
// ---------------------------------------------------------------------------

function loadVideo(url = "", metadata = null, { manterTentativas = false } = {}) {
  clearTimers();

  const alvo = resolveMediaUrl(url);

  // A mesma fonte já está carregada/carregando: não reinicia o player à toa
  // (evita o "pisca" quando o catálogo devolve o vídeo que já está tocando).
  if (alvo && alvo === urlAtual && (carregado || metadata === null)) {
    if (metadata) updateVideoInfo(metadata);
    return;
  }

  destroyHls();
  hideError();

  // O contador de tentativas de rede só zera ao TROCAR de vídeo: se ele fosse
  // resetado a cada retry, o limite nunca seria atingido e voltaríamos ao loop
  // infinito de requisições (o bug original do player). `manterTentativas` vem
  // do retry automático, que recarrega a MESMA fonte.
  const mesmaFonte = manterTentativas && alvo === urlAtual;

  urlAtual = alvo || null;
  if (!mesmaFonte) tentativasRede = 0;
  carregado = false;
  fonteAtual = { url: alvo, metadata };

  if (metadata) {
    updateVideoInfo(metadata);
    // POST /watch só para vídeo REAL do banco (id de demonstração poluiria o
    // /trending com vídeos que não existem). Com sessão ativa, a view vai
    // para o usuário logado — é o que alimenta as recomendações pessoais.
    if (metadata.id && !metadata.demo) {
      registrarVisualizacao(metadata.id, idUsuarioAtual() || CONFIG.USER_ID);
    }
  }

  if (window.Hls && Hls.isSupported()) {
    if (!alvo) {
      showError("Nenhuma URL HLS foi configurada.");
      return;
    }
    showLoading();
    initializeHls(alvo);
    return;
  }

  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    if (!alvo) {
      showError("Nenhuma URL HLS foi configurada.");
      return;
    }
    showLoading();
    video.src = alvo;
    video.addEventListener("loadedmetadata", () => {
      carregado = true;
      hideLoading();
    }, { once: true });
    video.addEventListener("error", () => {
      diagnosticarFalha(alvo);
    }, { once: true });
    return;
  }

  // Sem HLS.js e sem HLS nativo não há URL que resolva: o problema é o
  // navegador (por isso este aviso tem prioridade sobre "URL não configurada").
  showError("Este navegador não suporta HLS.");
}

function repetirUltimaFonte() {
  if (!fonteAtual) {
    iniciar();
    return;
  }
  const { url, metadata } = fonteAtual;
  urlAtual = null; // força o recarregamento mesmo que seja a mesma URL
  loadVideo(url, metadata);
}

function initializeHls(url) {
  hls = new Hls({
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 30,
    maxBufferLength: 30,
    capLevelToPlayerSize: true
  });

  qualityManager = new QualityManager(hls, video, elements);

  hls.loadSource(url);
  hls.attachMedia(video);

  hls.on(Hls.Events.MANIFEST_PARSED, (_, data) => {
    carregado = true;
    tentativasRede = 0;
    hideLoading();
    hideError();
    console.info(`HLS carregado: ${data.levels.length} níveis de qualidade.`);
  });

  hls.on(Hls.Events.FRAG_BUFFERED, () => {
    // Rede voltou ao normal: zera o contador para não desistir cedo demais.
    tentativasRede = 0;
    hideLoading();
  });

  hls.on(Hls.Events.ERROR, (_, data) => {
    console.error("HLS error:", data);

    if (!data.fatal) return;

    switch (data.type) {
      case Hls.ErrorTypes.NETWORK_ERROR:
        tratarErroDeRede(data, url);
        break;

      case Hls.ErrorTypes.MEDIA_ERROR:
        showError("O navegador encontrou um problema com a mídia. Tentando recuperar...");
        try {
          hls.recoverMediaError();
        } catch (error) {
          console.error("Falha ao recuperar a mídia:", error);
          destroyHls();
        }
        break;

      default:
        showError("Erro fatal no streaming HLS. Clique em \"Tentar novamente\".");
        destroyHls();
        break;
    }
  });
}

function tratarErroDeRede(data, url) {
  const status = data?.response?.code;

  // 404/410: o arquivo HLS não existe. Repetir não vai mudar nada — o player
  // consulta /status e /media e explica o que aconteceu (era aqui que a versão
  // anterior entrava em loop infinito de retry).
  if (status === 404 || status === 410) {
    destroyHls();
    diagnosticarFalha(url);
    return;
  }

  tentativasRede += 1;

  // >= (e não >): a última tentativa permitida é a de número
  // MAX_TENTATIVAS_REDE — passar disso significa insistir numa rede que não
  // responde, que era exatamente o loop infinito de antes.
  if (tentativasRede >= MAX_TENTATIVAS_REDE) {
    destroyHls();
    showError(
      `Falha de rede ao carregar o vídeo após ${MAX_TENTATIVAS_REDE} tentativas ` +
      `(${status || "sem resposta do servidor"}). Confira a conexão e o backend em ${API_BASE_URL}.`
    );
    return;
  }

  showError(
    `Falha de rede ao carregar o vídeo. Tentando novamente (${tentativasRede + 1}/${MAX_TENTATIVAS_REDE})...`
  );
  retryTimer = setTimeout(() => {
    retryTimer = null;
    loadVideo(urlAtual, fonteAtual?.metadata, { manterTentativas: true });
  }, INTERVALO_RETRY_MS);
}

// ---------------------------------------------------------------------------
// Diagnóstico: por que não deu play?
// ---------------------------------------------------------------------------

/**
 * Consulta /status/{id} e /media/{id} e devolve uma mensagem legível.
 *
 * Qualquer falha nestas consultas vira `null` — quem chama decide a mensagem
 * genérica. Nenhuma exceção sai daqui: diagnóstico nunca pode quebrar o player.
 */
async function diagnosticarFalha(url) {
  hideLoading();
  const videoId = fonteAtual?.metadata?.id || CONFIG.VIDEO_ID || VIDEO_DA_URL;
  const mensagem = await montarMensagemDeFalha(videoId, url);
  showError(mensagem);
}

async function montarMensagemDeFalha(videoId, url) {
  // Sem video_id não há o que consultar no backend: sobra a URL (caso de um
  // HLS_URL forçado no config.js que não existe).
  if (!videoId) {
    return url
      ? `Não foi possível carregar o stream (${url}). Verifique a URL em config.js.`
      : "Nenhuma fonte de vídeo foi informada (sem ?video= e catálogo vazio).";
  }

  const [status, media] = await Promise.all([
    consultar(getVideoStatus, videoId),
    consultar(getMedia, videoId)
  ]);

  const estado = status?.status;

  if (!media || media.media_pronta === false) {
    if (estado === "failed") {
      return (
        "Este vídeo não está pronto: a transcodificação FALHOU no servidor" +
        (status?.erro ? ` (${status.erro})` : "") +
        ". Veja o log do worker Celery — o FFmpeg está instalado e no PATH?"
      );
    }

    if (estado === "processing" || estado === "pending") {
      const rotulo = estado === "pending" ? "na fila" : "transcodificando";
      agendarReconsulta(videoId);
      return (
        `Este vídeo ainda não está pronto: está ${rotulo} (FFmpeg gerando as qualidades HLS). ` +
        `A página consulta de novo sozinha a cada ${INTERVALO_PROCESSANDO_MS / 1000}s — ` +
        "acompanhe o worker do Celery no terminal."
      );
    }

    // Com bucket público configurado, /media devolve s3_master_url: a mídia
    // deveria estar no Storage (Supabase/S3), não no disco da API — dizer
    // "videos/{id}/" aqui mandaria o time procurar no lugar errado.
    const onde = media?.s3_master_url
      ? `nem no disco da API, nem no bucket (${media.s3_master_url})`
      : `em videos/${videoId}/`;
    return (
      "Este vídeo ainda não está pronto para reprodução: os arquivos HLS não foram " +
      `encontrados ${onde} (master.m3u8 ausente). Rode ` +
      "`python scripts/demo_completo.py` ou envie o vídeo novamente pela home."
    );
  }

  if (estado === "processing" || estado === "pending") {
    const rotulo = estado === "pending" ? "na fila" : "transcodificando";
    agendarReconsulta(videoId);
    return (
      `Este vídeo ainda está ${rotulo} (FFmpeg gerando as qualidades HLS). ` +
      `A página tenta de novo sozinha a cada ${INTERVALO_PROCESSANDO_MS / 1000}s — ` +
      "acompanhe o worker do Celery no terminal."
    );
  }

  if (estado === "failed") {
    return (
      "A transcodificação deste vídeo FALHOU no servidor" +
      (status?.erro ? `: ${status.erro}` : "") +
      ". Veja o log do worker Celery (o FFmpeg está instalado e no PATH?)."
    );
  }

  if (media && media.media_pronta === false) {
    return (
      "O vídeo consta como concluído no banco, mas os arquivos HLS não foram " +
      `encontrados em videos/${videoId}/ (master.m3u8 ausente). Rode ` +
      "`python scripts/demo_completo.py` ou envie o vídeo novamente pela home."
    );
  }

  return (
    `Não foi possível carregar o stream ${url || "do vídeo"}. ` +
    `Verifique se a API (${API_BASE_URL}) está no ar e se a pasta videos/ tem os arquivos.`
  );
}

/**
 * Por que o vídeo pedido na URL não veio do banco.
 * "não está pronto" aparece em todos os casos de propósito: é o que o usuário
 * precisa entender (e o que os testes de contrato verificam).
 */
function mensagemVideoNaoEncontrado(videoId, motivo) {
  if (motivo === "inexistente") {
    return (
      `Este vídeo não está pronto para reprodução: o id "${videoId}" não foi ` +
      "encontrado no banco. Ele pode ter sido removido — abra o catálogo para " +
      "escolher outro vídeo."
    );
  }

  if (motivo === "banco") {
    return (
      "Este vídeo não está pronto: o backend respondeu HTTP 503 (banco de dados " +
      "não configurado). Preencha SUPABASE_URL e SUPABASE_KEY no .env — sem eles " +
      "o backend usa o banco local data/videos.json, que precisa ter o vídeo."
    );
  }

  if (motivo === "servidor") {
    return (
      "Este vídeo não está pronto: o backend retornou um erro interno (HTTP 5xx). " +
      "Confira o terminal do uvicorn para ver o stacktrace."
    );
  }

  return (
    `Este vídeo não está pronto: não foi possível consultar a API em ${API_BASE_URL}. ` +
    "Suba o backend com `uvicorn app.main:app --reload` e recarregue a página."
  );
}

/** Vídeo sem stream (mídia ainda não gerada): mesma explicação, sem tentar o play. */
async function diagnosticarSemMidia(item) {
  hideLoading();
  const mensagem = await montarMensagemDeFalha(item.id, item.hlsUrl);
  showError(mensagem);
}

async function consultar(fn, videoId) {
  try {
    return await fn(videoId);
  } catch (error) {
    console.info(`Diagnóstico indisponível para ${videoId}:`, error.message);
    return null;
  }
}

/** Enquanto estiver processando, reconsulta sozinho (sem spam de requests). */
function agendarReconsulta(videoId) {
  clearProcessandoTimer();
  processandoTimer = setTimeout(async () => {
    processandoTimer = null;
    const { video: item } = await buscarVideoDaApi(videoId);
    if (item && temStream(item)) {
      loadVideo(resolveMediaUrl(item.hlsUrl), item);
      return;
    }
    const status = await consultar(getVideoStatus, videoId);
    if (status?.status === "processing" || status?.status === "pending") {
      agendarReconsulta(videoId);
    }
  }, INTERVALO_PROCESSANDO_MS);
}

// ---------------------------------------------------------------------------
// Interface
// ---------------------------------------------------------------------------

function destroyHls() {
  if (hls) {
    hls.destroy();
    hls = null;
  }

  qualityManager = null;
}

function clearTimers() {
  clearRetryTimer();
  clearProcessandoTimer();
}

function clearRetryTimer() {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
}

function clearProcessandoTimer() {
  if (processandoTimer) {
    clearTimeout(processandoTimer);
    processandoTimer = null;
  }
}

function showLoading() {
  elements.playerLoading.classList.remove("hidden");
}

function hideLoading() {
  elements.playerLoading.classList.add("hidden");
}

function showError(message) {
  hideLoading();
  destroyHls();
  carregado = false;
  elements.playerErrorMessage.textContent = message;
  elements.playerError.classList.remove("hidden");
}

function hideError() {
  elements.playerError.classList.add("hidden");
}

function erroVisivel() {
  return Boolean(elements.playerError) &&
    !elements.playerError.classList.contains("hidden");
}

/** `?video={id}` na barra de endereço — compartilhar/recarregar mantém o vídeo. */
function atualizarUrlDaPagina(videoId) {
  if (videoId) definirParametro("video", videoId);
}

/**
 * A busca do topo da watch page não tinha handler: o submit recarregava a
 * página e perdia o vídeo em reprodução. Agora ela leva para a home, que é
 * quem sabe buscar no catálogo (GET /catalogo?q=...).
 */
function ligarBusca() {
  const form = document.querySelector("#searchForm");
  const input = document.querySelector("#searchInput");
  if (!form || !input) return;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const termo = input.value.trim();
    window.location.href = `home.html${termo ? `?q=${encodeURIComponent(termo)}` : ""}`;
  });
}

function updateVideoInfo(videoData) {
  if (!videoData) return;

  if (videoData.title && elements.videoTitle) {
    elements.videoTitle.textContent = videoData.title;
    document.title = `${videoData.title} — EduStream`;
  }

  if (elements.views) {
    const views = videoData.views;
    elements.views.textContent =
      typeof views === "number" ? formatarVisualizacoes(views) : (views ?? "");
  }

  if (elements.date) {
    const data = formatarData(videoData.createdAt);
    const autor = videoData.author ? `Por ${videoData.author}` : "";
    elements.date.textContent = [autor, data].filter(Boolean).join(" • ");
  }

  if (elements.description) {
    const partes = [videoData.description, videoData.category].filter(Boolean);
    if (partes.length) {
      elements.description.textContent = partes.join(" — categoria: ");
    }
  }
}

/** "2026-09-01T10:00:00+00:00" -> "1 de setembro de 2026" ("" se inválida). */
export function formatarData(valor) {
  if (!valor) return "";

  const data = new Date(valor);
  if (Number.isNaN(data.getTime())) return "";

  try {
    return data.toLocaleDateString("pt-BR", {
      day: "numeric",
      month: "long",
      year: "numeric"
    });
  } catch (error) {
    return data.toISOString().slice(0, 10);
  }
}

window.addEventListener("online", () => {
  elements.connectionMessage.textContent =
    "Conexão recuperada. O player pode voltar a aumentar a qualidade automaticamente.";
});

window.addEventListener("offline", () => {
  elements.connectionMessage.textContent =
    "Você está offline. A reprodução poderá ser interrompida.";
  elements.connectionAlert.classList.remove("hidden");
});

// Exposto apenas para facilitar testes/manutenção no navegador.
window.eduStreamPlayer = {
  loadVideo,
  destroy: destroyHls,
  getHls: () => hls,
  getQualityManager: () => qualityManager,
  getVideoAtual: () => fonteAtual,
  getElements: () => elements
};
