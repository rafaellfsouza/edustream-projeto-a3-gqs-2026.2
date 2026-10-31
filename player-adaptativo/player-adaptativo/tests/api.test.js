/**
 * Testes REAIS da camada de API do player (js/api.js).
 *
 * Estes são os endpoints do contrato #6 da documentação técnica:
 *   GET  /status/{video_id}
 *   GET  /videos/{id}/relacionados
 *   GET  /recomendacoes/{user_id}
 *   GET  /trending
 *   POST /watch
 *
 * O `fetch` é substituído por um dublê — nenhum teste faz HTTP de verdade,
 * mas todos validam URL, método, cabeçalhos, corpo e tratamento de erro.
 */
import { jest } from "@jest/globals";

import {
  API_BASE_URL,
  getRecommendations,
  getRelatedVideos,
  getTrending,
  getVideoStatus,
  registerWatch,
} from "../js/api.js";

function mockarFetchOk(payload = { ok: true }) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  return global.fetch;
}

function mockarFetchErro(status = 500) {
  global.fetch = jest.fn(async () => ({
    ok: false,
    status,
    json: async () => ({}),
  }));
  return global.fetch;
}

function ultimaChamada() {
  const [url, options] = global.fetch.mock.calls.at(-1);
  return { url, options };
}

beforeEach(() => {
  jest.restoreAllMocks();
});

describe("api.js — configuração", () => {
  test("usa a API local como padrão quando não há PLAYER_CONFIG", () => {
    expect(API_BASE_URL).toBe("http://localhost:8000");
  });
});

describe("api.js — rotas do contrato #6", () => {
  test("GET /status/{video_id}", async () => {
    mockarFetchOk({ video_id: "abc", status: "completed" });

    const resposta = await getVideoStatus("abc");

    expect(ultimaChamada().url).toBe("http://localhost:8000/status/abc");
    expect(resposta.status).toBe("completed");
  });

  test("GET /videos/{id}/relacionados", async () => {
    mockarFetchOk([]);

    await getRelatedVideos("abc");

    expect(ultimaChamada().url).toBe("http://localhost:8000/videos/abc/relacionados");
  });

  test("GET /recomendacoes/{user_id}", async () => {
    mockarFetchOk([]);

    await getRecommendations("gustavo");

    expect(ultimaChamada().url).toBe("http://localhost:8000/recomendacoes/gustavo");
  });

  test("GET /trending", async () => {
    mockarFetchOk([]);

    await getTrending();

    expect(ultimaChamada().url).toBe("http://localhost:8000/trending");
  });

  test("POST /watch com o payload em JSON", async () => {
    mockarFetchOk({ registrado: true });

    await registerWatch({ video_id: "abc", user_id: "gustavo" });

    const { url, options } = ultimaChamada();
    expect(url).toBe("http://localhost:8000/watch");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ video_id: "abc", user_id: "gustavo" });
  });

  test("leituras usam GET (método padrão do fetch)", async () => {
    mockarFetchOk({});

    await getTrending();

    expect(ultimaChamada().options.method).toBeUndefined();
  });
});

describe("api.js — cabeçalhos e serialização", () => {
  test("sempre envia Content-Type application/json", async () => {
    mockarFetchOk({});

    await getVideoStatus("abc");

    expect(ultimaChamada().options.headers["Content-Type"]).toBe("application/json");
  });

  test("devolve o JSON já parseado (o caller não precisa chamar .json())", async () => {
    mockarFetchOk({ video_id: "abc", status: "processing", caminho_hls: null });

    const resposta = await getVideoStatus("abc");

    expect(typeof resposta).toBe("object");
    expect(resposta).toEqual({ video_id: "abc", status: "processing", caminho_hls: null });
  });
});

describe("api.js — codificação de parâmetros", () => {
  test.each([
    ["id com espaço", "meu video", "meu%20video"],
    ["id com barra", "a/b", "a%2Fb"],
    ["id com acento", "vídeo", "v%C3%ADdeo"],
  ])("codifica %s na URL", async (_descricao, entrada, esperado) => {
    mockarFetchOk({});

    await getVideoStatus(entrada);

    expect(ultimaChamada().url).toBe(`http://localhost:8000/status/${esperado}`);
  });
});

describe("api.js — tratamento de erro", () => {
  test.each([
    ["404", 404],
    ["500", 500],
    ["503", 503],
  ])("HTTP %s lança erro com o status na mensagem", async (_descricao, status) => {
    mockarFetchErro(status);

    await expect(getVideoStatus("abc")).rejects.toThrow(`API respondeu com HTTP ${status}`);
  });

  test("falha de rede propaga a exceção do fetch", async () => {
    global.fetch = jest.fn(async () => {
      throw new TypeError("Failed to fetch");
    });

    await expect(getTrending()).rejects.toThrow("Failed to fetch");
  });

  test("o corpo do erro é lido para anexar o detail legível do backend", async () => {
    // Mudou com a feature de autenticação: as rotas /auth devolvem mensagens
    // prontas para o usuário em `detail` ("E-mail ou senha incorretos."), e o
    // login.html as exibe no formulário. Por isso o corpo AGORA é lido.
    const json = jest.fn(async () => ({ detail: "mensagem do backend" }));
    global.fetch = jest.fn(async () => ({ ok: false, status: 500, json }));

    await expect(getTrending()).rejects.toMatchObject({
      status: 500,
      detail: "mensagem do backend",
    });
    expect(json).toHaveBeenCalled();
  });

  test("corpo de erro ilegível não impede o ApiError (detail fica null)", async () => {
    const json = jest.fn(async () => {
      throw new Error("corpo não é JSON");
    });
    global.fetch = jest.fn(async () => ({ ok: false, status: 502, json }));

    await expect(getTrending()).rejects.toMatchObject({
      status: 502,
      detail: null,
    });
  });
});
