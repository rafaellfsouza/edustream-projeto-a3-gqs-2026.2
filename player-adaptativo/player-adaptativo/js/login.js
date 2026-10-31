/**
 * Página de login/cadastro (login.html) — js/login.js.
 *
 * Fluxo:
 *   1. Abas "Entrar" / "Criar conta" (ou ?modo=cadastro na URL, que é o
 *      link do menu de perfil anônimo).
 *   2. Submit → POST /auth/login ou POST /auth/registrar (js/api.js).
 *   3. Sucesso → salva a sessão (js/auth.js) e volta para a home — ou para a
 *      página pedida em ?next= (ex.: o vídeo que o usuário tentou abrir).
 *
 * Erros viram mensagem legível no formulário: a API devolve `detail`
 * ("E-mail ou senha incorretos.", "Já existe uma conta com este e-mail…") e o
 * ApiError de js/api.js carrega esse texto. Backend fora do ar → instrução de
 * como subir, no mesmo padrão das outras páginas do player.
 */
import { fazerLogin, registrarUsuario, API_BASE_URL } from "./api.js";
import { salvarSessao, usuarioAtual } from "./auth.js";

const PARAMS = new URLSearchParams(window.location.search);

const elements = {
  tabLogin: document.querySelector("#tabLogin"),
  tabRegistro: document.querySelector("#tabRegistro"),
  formLogin: document.querySelector("#formLogin"),
  formRegistro: document.querySelector("#formRegistro"),
  loginErro: document.querySelector("#loginErro"),
  loginSucesso: document.querySelector("#loginSucesso"),
  registroErro: document.querySelector("#registroErro"),
  registroSucesso: document.querySelector("#registroSucesso"),
  loginSubmit: document.querySelector("#loginSubmit"),
  registroSubmit: document.querySelector("#registroSubmit"),
  irParaCadastro: document.querySelector("#irParaCadastro"),
  irParaLogin: document.querySelector("#irParaLogin"),
};

/** Página para voltar depois do login (padrão: home). */
function destinoPosLogin() {
  const next = PARAMS.get("next");
  return next && next.startsWith("./") ? next : "./home.html";
}

/** Mostra o formulário pedido e marca a aba ativa (acessível via aria). */
export function alternarAba(modo) {
  const login = modo !== "cadastro";

  elements.tabLogin?.classList.toggle("active", login);
  elements.tabRegistro?.classList.toggle("active", !login);
  elements.tabLogin?.setAttribute("aria-selected", String(login));
  elements.tabRegistro?.setAttribute("aria-selected", String(!login));
  elements.formLogin?.classList.toggle("hidden", !login);
  elements.formRegistro?.classList.toggle("hidden", login);
}

function mostrarErro(elemento, mensagem) {
  if (!elemento) return;
  elemento.textContent = mensagem;
  elemento.classList.remove("hidden");
}

function limparMensagens() {
  for (const elemento of [
    elements.loginErro, elements.loginSucesso,
    elements.registroErro, elements.registroSucesso,
  ]) {
    if (elemento) elemento.classList.add("hidden");
  }
}

/** Traduz o erro da API para o texto que aparece no formulário. */
export function mensagemDeErro(error) {
  if (error?.detail) return error.detail;

  if (error?.status === 401) return "E-mail ou senha incorretos.";
  if (error?.status === 409) return "Já existe uma conta com este e-mail. Faça login.";
  if (error?.status === 422) return "Revise os campos destacados e tente novamente.";
  if (error?.status === 503) return "Banco de usuários indisponível no momento.";

  return (
    `Não foi possível falar com a API em ${API_BASE_URL}. ` +
    "Suba o backend com `uvicorn app.main:app --reload` e tente de novo."
  );
}

function setLoading(botao, carregando, textoOriginal) {
  if (!botao) return;
  botao.disabled = Boolean(carregando);
  botao.textContent = carregando ? "Aguarde…" : textoOriginal;
}

/** Salva a sessão e navega — sucesso dos dois formulários. */
function concluirSessao(dados, elementoSucesso) {
  salvarSessao(dados);

  if (elementoSucesso) {
    const nome = String(usuarioAtual()?.nome || "").trim().split(/\s+/)[0];
    elementoSucesso.textContent = `Bem-vindo(a), ${nome || "usuário"}! Redirecionando…`;
    elementoSucesso.classList.remove("hidden");
  }
  window.location.href = destinoPosLogin();
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

elements.formLogin?.addEventListener("submit", async (event) => {
  event.preventDefault();
  limparMensagens();

  const email = document.querySelector("#loginEmail")?.value?.trim() || "";
  const senha = document.querySelector("#loginSenha")?.value || "";

  if (!email || !senha) {
    mostrarErro(elements.loginErro, "Preencha e-mail e senha.");
    return;
  }

  setLoading(elements.loginSubmit, true, "Entrar");
  try {
    const dados = await fazerLogin({ email, senha });
    concluirSessao(dados, elements.loginSucesso);
  } catch (error) {
    mostrarErro(elements.loginErro, mensagemDeErro(error));
  } finally {
    setLoading(elements.loginSubmit, false, "Entrar");
  }
});

elements.formRegistro?.addEventListener("submit", async (event) => {
  event.preventDefault();
  limparMensagens();

  const nome = document.querySelector("#registroNome")?.value?.trim() || "";
  const email = document.querySelector("#registroEmail")?.value?.trim() || "";
  const senha = document.querySelector("#registroSenha")?.value || "";
  const tipoUsuario =
    document.querySelector('input[name="tipoUsuario"]:checked')?.value || "aluno";

  if (nome.length < 3) {
    mostrarErro(elements.registroErro, "Informe seu nome completo (mínimo 3 letras).");
    return;
  }
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    mostrarErro(elements.registroErro, "Informe um e-mail válido (nome@dominio.com).");
    return;
  }
  if (senha.length < 6) {
    mostrarErro(elements.registroErro, "A senha precisa ter pelo menos 6 caracteres.");
    return;
  }

  setLoading(elements.registroSubmit, true, "Criar conta e entrar");
  try {
    const dados = await registrarUsuario({ nome, email, senha, tipoUsuario });
    concluirSessao(dados, elements.registroSucesso);
  } catch (error) {
    mostrarErro(elements.registroErro, mensagemDeErro(error));
  } finally {
    setLoading(elements.registroSubmit, false, "Criar conta e entrar");
  }
});

elements.tabLogin?.addEventListener("click", () => alternarAba("login"));
elements.tabRegistro?.addEventListener("click", () => alternarAba("cadastro"));
elements.irParaCadastro?.addEventListener("click", () => alternarAba("cadastro"));
elements.irParaLogin?.addEventListener("click", () => alternarAba("login"));

// Sessão já ativa? Não tem por que mostrar o login de novo.
if (usuarioAtual()) {
  window.location.href = destinoPosLogin();
} else if (PARAMS.get("modo") === "cadastro") {
  alternarAba("cadastro");
}

export { destinoPosLogin, concluirSessao };
