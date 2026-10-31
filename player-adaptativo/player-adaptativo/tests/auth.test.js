/**
 * Testes da camada de autenticação do player:
 *   js/auth.js  — sessão em localStorage (salvar, ler, encerrar)
 *   js/api.js   — endpoints /auth/* e o cabeçalho Authorization automático
 *
 * O `fetch` é dublado (mesmo padrão de tests/api.test.js) — nenhum teste faz
 * HTTP de verdade. O localStorage do jsdom é limpo a cada teste.
 */
import { jest } from "@jest/globals";

import {
  CHAVE_SESSAO,
  estaLogado,
  idUsuarioAtual,
  inicialDoNome,
  logout,
  rotuloTipo,
  salvarSessao,
  sessaoAtual,
  usuarioAtual,
} from "../js/auth.js";

import {
  fazerLogin,
  listarUsuarios,
  obterPerfil,
  registrarUsuario,
} from "../js/api.js";

const SESSAO_VALIDA = {
  token: "token-assinado-123",
  usuario: {
    usuario_id: "u-123",
    nome: "Maria Silva",
    email: "maria@exemplo.com",
    tipo_usuario: "professor",
  },
};

function mockarFetchOk(payload = { ok: true }) {
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => payload,
  }));
  return global.fetch;
}

function mockarFetchErro(status, corpo = {}) {
  global.fetch = jest.fn(async () => ({
    ok: false,
    status,
    json: async () => corpo,
  }));
  return global.fetch;
}

function ultimaChamada() {
  const [url, options] = global.fetch.mock.calls.at(-1);
  return { url, options };
}

beforeEach(() => {
  jest.restoreAllMocks();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// js/auth.js — sessão
// ---------------------------------------------------------------------------

describe("auth.js — sessão em localStorage", () => {
  test("sem sessão: tudo devolve null/false", () => {
    expect(sessaoAtual()).toBeNull();
    expect(usuarioAtual()).toBeNull();
    expect(idUsuarioAtual()).toBeNull();
    expect(estaLogado()).toBe(false);
  });

  test("salvarSessao guarda token + usuario e os devolve", () => {
    expect(salvarSessao(SESSAO_VALIDA)).toBe(true);

    expect(estaLogado()).toBe(true);
    expect(usuarioAtual().nome).toBe("Maria Silva");
    expect(idUsuarioAtual()).toBe("u-123");
    expect(sessaoAtual().token).toBe("token-assinado-123");
  });

  test("salvarSessao recusa dados incompletos", () => {
    expect(salvarSessao({ token: "x" })).toBe(false);
    expect(salvarSessao({ usuario: {} })).toBe(false);
    expect(salvarSessao(null)).toBe(false);
    expect(estaLogado()).toBe(false);
  });

  test("sessão corrompida no storage não quebra a página", () => {
    localStorage.setItem(CHAVE_SESSAO, "{ json inválido");

    expect(sessaoAtual()).toBeNull();
    expect(usuarioAtual()).toBeNull();
    expect(estaLogado()).toBe(false);
  });

  test("logout limpa a sessão", () => {
    salvarSessao(SESSAO_VALIDA);
    logout();

    expect(estaLogado()).toBe(false);
    expect(usuarioAtual()).toBeNull();
    expect(localStorage.getItem(CHAVE_SESSAO)).toBeNull();
  });

  test("rotuloTipo traduz o tipo_usuario", () => {
    expect(rotuloTipo({ tipo_usuario: "aluno" })).toBe("Aluno");
    expect(rotuloTipo({ tipo_usuario: "professor" })).toBe("Professor");
    expect(rotuloTipo({ tipo_usuario: "???" })).toBe("");
    expect(rotuloTipo(null)).toBe("");
  });

  test("inicialDoNome devolve a primeira letra maiúscula", () => {
    expect(inicialDoNome({ nome: "maria silva" })).toBe("M");
    expect(inicialDoNome({ nome: "" })).toBe("?");
    expect(inicialDoNome(null)).toBe("?");
  });
});

// ---------------------------------------------------------------------------
// js/api.js — rotas de autenticação
// ---------------------------------------------------------------------------

describe("api.js — autenticação", () => {
  test("POST /auth/registrar envia o corpo no formato do backend", async () => {
    mockarFetchOk(SESSAO_VALIDA);

    await registrarUsuario({
      nome: "Maria Silva",
      email: "maria@exemplo.com",
      senha: "segredo123",
      tipoUsuario: "professor",
    });

    const { url, options } = ultimaChamada();
    expect(url).toMatch(/\/auth\/registrar$/);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      nome: "Maria Silva",
      email: "maria@exemplo.com",
      senha: "segredo123",
      tipo_usuario: "professor",
    });
  });

  test("POST /auth/login envia e-mail e senha", async () => {
    mockarFetchOk(SESSAO_VALIDA);

    await fazerLogin({ email: "maria@exemplo.com", senha: "segredo123" });

    const { url, options } = ultimaChamada();
    expect(url).toMatch(/\/auth\/login$/);
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({
      email: "maria@exemplo.com",
      senha: "segredo123",
    });
  });

  test("GET /auth/me anexa o Bearer da sessão automaticamente", async () => {
    salvarSessao(SESSAO_VALIDA);
    mockarFetchOk({ usuario: SESSAO_VALIDA.usuario });

    await obterPerfil();

    const { url, options } = ultimaChamada();
    expect(url).toMatch(/\/auth\/me$/);
    expect(options.headers.Authorization).toBe("Bearer token-assinado-123");
  });

  test("GET /auth/usuarios (área do professor)", async () => {
    salvarSessao(SESSAO_VALIDA);
    mockarFetchOk({ usuarios: [], total: 0 });

    await listarUsuarios();

    const { url } = ultimaChamada();
    expect(url).toMatch(/\/auth\/usuarios$/);
  });

  test("sem sessão, nenhuma chamada leva Authorization", async () => {
    mockarFetchOk({ usuario: null });

    await obterPerfil();

    expect(ultimaChamada().options.headers.Authorization).toBeUndefined();
  });

  test("erro 401 do login carrega o detail legível do backend", async () => {
    mockarFetchErro(401, { detail: "E-mail ou senha incorretos." });

    await expect(
      fazerLogin({ email: "maria@exemplo.com", senha: "errada" })
    ).rejects.toMatchObject({
      name: "ApiError",
      status: 401,
      detail: "E-mail ou senha incorretos.",
    });
  });

  test("erro 409 do cadastro carrega o detail (e-mail duplicado)", async () => {
    mockarFetchErro(409, { detail: "Já existe uma conta com este e-mail. Faça login." });

    await expect(
      registrarUsuario({ nome: "Maria", email: "maria@exemplo.com", senha: "segredo123" })
    ).rejects.toMatchObject({ status: 409 });
  });

  test("corpo de erro não-JSON não quebra (detail fica null)", async () => {
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      json: async () => {
        throw new Error("não é JSON");
      },
    }));

    await expect(obterPerfil()).rejects.toMatchObject({ status: 500, detail: null });
  });
});
