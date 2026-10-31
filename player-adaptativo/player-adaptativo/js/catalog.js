/**
 * Adaptador entre a API (backend FastAPI) e os cards do player.
 *
 * Por que este arquivo existe:
 *   O backend responde no formato do contrato #2 da documentação técnica, em
 *   português (`video_id`, `titulo`, `hls_url`). Os cards do player esperam
 *   `id`, `title`, `hlsUrl`. Este módulo traduz um para o outro e — mais
 *   importante — garante que a página NUNCA fica vazia: se o backend estiver
 *   fora do ar, sem credenciais de banco (503) ou a rota não existir (404),
 *   devolvemos lista vazia e o player mantém os vídeos de demonstração.
 *
 *   É o padrão "enhancement progressivo": renderiza o demo na hora, troca por
 *   dados reais quando a API responde.
 */
import { getCatalogo, getRecommendations, getRelatedVideos, getTrending, getVideo, registerWatch } from "./api.js";
import { renderRecommendations, renderSidebar } from "./recommendations.js";
import { usuarioAtual } from "./auth.js";

/**
 * Resultado de uma consulta ao catálogo.
 *
 * `ok` separa duas situações que antes eram indistinguíveis (ambas davam []):
 * a API respondeu sem vídeos (catálogo vazio de verdade) x a API não respondeu
 * (backend fora do ar, 404, 503 sem credenciais). O player usa isso para
 * mostrar a mensagem certa em vez de tentar uma URL que não existe.
 */
function resultadoDaApi(itens, ok) {
  return { itens, ok };
}

/**
 * Formata um número de visualizações como o texto que aparece no card.
 * 842 -> "842 visualizações" · 1100 -> "1,1 mil visualizações"
 */
export function formatarVisualizacoes(quantidade) {
  const total = Number(quantidade);

  if (!Number.isFinite(total) || total <= 0) return "0 visualizações";

  if (total < 1000) {
    return `${total} visualiza${total === 1 ? "ção" : "ções"}`;
  }

  const milhares = total / 1000;
  const texto =
    milhares < 10
      ? milhares.toFixed(1).replace(".", ",")
      : String(Math.round(milhares));

  return `${texto} mil visualizações`;
}

/**
 * Converte um vídeo vindo da API (ou um demo, que já está no formato do card)
 * no objeto que `createCard()` sabe desenhar.
 */
export function paraCard(video) {
  if (!video || typeof video !== "object") return null;

  const views = video.views ?? video.visualizacoes;
  const hlsUrl = video.hlsUrl ?? video.hls_url ?? null;

  // `media_pronta` vem do backend (o master.m3u8 existe no disco?). Backend
  // antigo que não manda o campo: assumimos que sim, já que ele devolveu um
  // hls_url — e o player trata o 404 com mensagem clara se estiver errado.
  const pronta =
    video.mediaPronta ??
    video.media_pronta ??
    (video.demo ? false : Boolean(hlsUrl));

  return {
    id: video.id ?? video.video_id ?? "",
    title: video.title ?? video.titulo ?? "Vídeo sem título",
    views: typeof views === "number" ? formatarVisualizacoes(views) : views ?? "",
    duration: video.duration ?? video.duracao ?? "",
    thumbnail: video.thumbnail ?? video.thumbnail_url ?? "",
    hlsUrl,
    pronta,
    demo: Boolean(video.demo),
    description: video.description ?? video.descricao ?? "",
    author: video.author ?? video.autor ?? "",
    category: video.category ?? video.categoria ?? "",
    createdAt: video.createdAt ?? video.criado_em ?? "",
    score: typeof video.score === "number" ? video.score : null,
  };
}

/** O vídeo tem stream pronto para tocar? (é o que o player checa antes do play) */
export function temStream(video) {
  return Boolean(video?.hlsUrl && video.pronta !== false);
}

/**
 * Relacionados como lista simples ([] se a API falhar).
 * É a forma usada por quem só quer os cards; `consultarRelacionados` devolve
 * também se a API respondeu.
 */
export async function buscarRelacionados(videoId) {
  return (await consultarRelacionados(videoId)).itens;
}

/** Relacionados + estado da API (`ok=false` = backend não respondeu). */
export async function consultarRelacionados(videoId) {
  try {
    const corpo = await getRelatedVideos(videoId);
    return resultadoDaApi((corpo?.relacionados ?? []).map(paraCard).filter(Boolean), true);
  } catch (error) {
    console.info("Relacionados indisponíveis, mantendo demonstração:", error.message);
    return resultadoDaApi([], false);
  }
}

/** Vídeos em alta como lista simples ([] se a API falhar). */
export async function buscarEmAlta() {
  return (await consultarEmAlta()).itens;
}

/** Em alta + estado da API (`ok=false` = backend não respondeu). */
export async function consultarEmAlta() {
  try {
    const corpo = await getTrending();
    return resultadoDaApi((corpo?.trending ?? []).map(paraCard).filter(Boolean), true);
  } catch (error) {
    console.info("Em alta indisponível, mantendo demonstração:", error.message);
    return resultadoDaApi([], false);
  }
}

/**
 * Recomendações PESSOAIS do usuário logado — a integração login ↔ vídeos.
 *
 * GET /recomendacoes/{usuario_id}: o backend cruza as tags do histórico de
 * visualizações (alimentado pelo POST /watch quando o usuário está logado)
 * com o catálogo pronto. Sem sessão ativa devolve lista vazia com `ok=true`
 * (não é falha — é só um visitante anônimo).
 */
export async function consultarRecomendacoesPessoais() {
  const usuario = usuarioAtual();
  if (!usuario?.usuario_id) return resultadoDaApi([], true);

  try {
    const corpo = await getRecommendations(usuario.usuario_id);
    return resultadoDaApi(
      (corpo?.recomendacoes ?? []).map(paraCard).filter(Boolean),
      true
    );
  } catch (error) {
    console.info("Recomendações pessoais indisponíveis:", error.message);
    return resultadoDaApi([], false);
  }
}

/**
 * Catálogo completo de vídeos prontos (home estilo YouTube + busca).
 * Devolve [] se a API falhar — a home mostra o estado vazio explicando o que fazer.
 */
export async function buscarCatalogo(termo = "", somenteProntos = true) {
  try {
    const corpo = await getCatalogo(termo, somenteProntos);
    return (corpo?.videos ?? []).map(paraCard).filter(Boolean);
  } catch (error) {
    console.info("Catálogo indisponível:", error.message);
    return [];
  }
}

/**
 * Grade inicial da watch page quando não há vídeo selecionado: o catálogo do
 * banco (GET /catalogo?prontos=1), no mesmo formato { itens, ok }.
 */
export async function consultarGradeInicial() {
  try {
    const corpo = await getCatalogo("", true);
    return resultadoDaApi((corpo?.videos ?? []).map(paraCard).filter(Boolean), true);
  } catch (error) {
    console.info("Catálogo indisponível para a grade inicial:", error.message);
    return resultadoDaApi([], false);
  }
}

/**
 * Estado do catálogo na API: quantos vídeos prontos existem e se a API
 * respondeu. A home usa isto para diferenciar "catálogo vazio" de
 * "backend fora do ar" no estado vazio da página.
 */
export async function consultarCatalogo(termo = "", somenteProntos = true) {
  try {
    const corpo = await getCatalogo(termo, somenteProntos);
    const itens = (corpo?.videos ?? []).map(paraCard).filter(Boolean);
    return { itens, ok: true, total: corpo?.total ?? itens.length };
  } catch (error) {
    console.info("Catálogo indisponível:", error.message);
    return { itens: [], ok: false, total: 0 };
  }
}

/**
 * Um vídeo pelo id (a watch page abre com ?video={id} e busca este metadado).
 *
 * Devolve `{ video, motivo }` — `motivo` ("inexistente" | "banco" | "api-fora")
 * permite ao player explicar exatamente o que aconteceu em vez de dizer só
 * "não foi possível carregar".
 */
export async function buscarVideoDaApi(videoId) {
  try {
    return { video: paraCard(await getVideo(videoId)), motivo: null };
  } catch (error) {
    console.info(`Vídeo ${videoId} indisponível na API:`, error.message);
    return { video: null, motivo: motivoDaFalha(error) };
  }
}

/** Classifica a falha da API para o usuário (404 x 503 x rede). */
export function motivoDaFalha(error) {
  if (error?.status === 404) return "inexistente";
  if (error?.status === 503) return "banco";
  if (error?.status >= 500) return "servidor";
  return "api-fora";
}

/**
 * Registra a visualização (alimenta /trending e /recomendacoes no backend).
 * Devolve false em vez de lançar: falhar aqui não pode travar a reprodução.
 */
export async function registrarVisualizacao(videoId, userId) {
  if (!videoId) return false;

  try {
    await registerWatch({ video_id: videoId, user_id: userId ?? null });
    return true;
  } catch (error) {
    console.info("Não foi possível registrar a visualização:", error.message);
    return false;
  }
}

/**
 * Troca os cards de demonstração pelos dados reais da API.
 *
 * Só redesenha quando vem conteúdo — assim, com o backend desligado, a página
 * continua exatamente como estava (com os demos).
 *
 * `recomendadosContainer` (opcional): bloco "Recomendados para você" da
 * watch page. Só é preenchido com sessão ativa (login.html) — o histórico do
 * usuário logado alimenta GET /recomendacoes/{usuario_id} no backend.
 */
export async function atualizarCatalogoDaApi({ relatedContainer, sidebarContainer, recomendadosContainer, videoId }) {
  // Sem video_id (abriu a watch page direto, sem ?video=) não há "relacionados"
  // o que consultar: a grade inicial vem do CATÁLOGO do banco — que é a lista
  // completa de vídeos prontos, e ainda permite ao player dar play no primeiro.
  const [relacionadosRes, emAltaRes, recomendadosRes] = await Promise.all([
    videoId ? consultarRelacionados(videoId) : consultarGradeInicial(),
    consultarEmAlta(),
    recomendadosContainer
      ? consultarRecomendacoesPessoais()
      : Promise.resolve(resultadoDaApi([], true)),
  ]);

  const relacionados = relacionadosRes.itens;
  const emAlta = emAltaRes.itens;
  const recomendados = recomendadosRes.itens;

  if (relacionados.length && relatedContainer) {
    renderRecommendations(relatedContainer, relacionados);
  }

  if (emAlta.length && sidebarContainer) {
    renderSidebar(sidebarContainer, emAlta);
  }

  if (recomendadosContainer) {
    if (recomendados.length) {
      renderSidebar(recomendadosContainer, recomendados);
    } else {
      recomendadosContainer.replaceChildren();
    }
  }

  return {
    relacionados,
    emAlta,
    recomendados,
    apiRespondeu: relacionadosRes.ok || emAltaRes.ok,
  };
}
