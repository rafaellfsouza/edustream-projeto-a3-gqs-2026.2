/**
 * Sessão do usuário logado — js/auth.js.
 *
 * Guarda em localStorage o par {token, usuario} devolvido por
 * POST /auth/login e POST /auth/registrar, e expõe os helpers que o resto do
 * front usa:
 *
 *   usuarioAtual() / idUsuarioAtual()  quem está logado (null = anônimo)
 *   tokenAtual()                       o Bearer que js/api.js anexa às chamadas
 *   estaLogado() / logout()            estado da sessão
 *   iniciarUiPerfil()                  liga o botão 👤 da topbar (menu com
 *                                      nome, perfil — aluno/professor — e Sair)
 *
 * Por que localStorage e não cookie? O player pode ser servido por outra
 * origem (Live Server :5500) e a API tem CORS aberto sem credenciais — o
 * cookie não viajaria entre origens. O token vai no cabeçalho Authorization,
 * que é justamente o que o CORS allow_headers=["*"] permite.
 *
 * Nenhum import aqui de propósito: api.js depende DESTE módulo (para anexar o
 * token), então auth.js não pode depender de api.js sem criar ciclo.
 */

export const CHAVE_SESSAO = "edustream:sessao";

/** localStorage pode lançar (navegador em modo privado restrito, testes). */
function storage() {
  try {
    return typeof localStorage !== "undefined" ? localStorage : null;
  } catch {
    return null;
  }
}

/**
 * Grava a sessão devolvida pela API ({token, usuario}).
 * Aceita também a resposta crua de /auth/login (mesmo formato).
 */
export function salvarSessao(dados) {
  const loja = storage();
  if (!loja || !dados?.token || !dados?.usuario) return false;

  try {
    loja.setItem(
      CHAVE_SESSAO,
      JSON.stringify({ token: dados.token, usuario: dados.usuario })
    );
    return true;
  } catch {
    return false;
  }
}

/** {token, usuario} da sessão atual, ou null (ausente/corrompida). */
export function sessaoAtual() {
  const loja = storage();
  if (!loja) return null;

  try {
    const bruto = loja.getItem(CHAVE_SESSAO);
    if (!bruto) return null;

    const sessao = JSON.parse(bruto);
    if (!sessao?.token || !sessao?.usuario) return null;
    return sessao;
  } catch {
    return null;
  }
}

/** Usuário logado ({usuario_id, nome, email, tipo_usuario}) ou null. */
export function usuarioAtual() {
  return sessaoAtual()?.usuario ?? null;
}

/** ID do usuário logado — alimenta POST /watch e GET /recomendacoes. */
export function idUsuarioAtual() {
  return usuarioAtual()?.usuario_id ?? null;
}

/** Token Bearer da sessão (ou null). */
export function tokenAtual() {
  return sessaoAtual()?.token ?? null;
}

export function estaLogado() {
  return Boolean(tokenAtual());
}

/** Encerra a sessão local (o token continua válido até expirar no backend). */
export function logout() {
  const loja = storage();
  if (loja) loja.removeItem(CHAVE_SESSAO);
}

/** "Professor" / "Aluno" — rótulo legível do tipo_usuario. */
export function rotuloTipo(usuario = usuarioAtual()) {
  const tipo = String(usuario?.tipo_usuario || "").toLowerCase();
  if (tipo === "professor") return "Professor";
  if (tipo === "aluno") return "Aluno";
  return "";
}

/** Primeira letra do nome, para o avatar do botão de perfil. */
export function inicialDoNome(usuario = usuarioAtual()) {
  const nome = String(usuario?.nome || "").trim();
  return nome ? nome[0].toUpperCase() : "?";
}

function escaparHtml(texto) {
  return String(texto ?? "").replace(
    /[&<>"']/g,
    (caractere) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        caractere
      ]
  );
}

/**
 * Liga o botão de perfil (#profileButton) da topbar.
 *
 * Logado   → avatar com a inicial, menu com nome, e-mail, selo do perfil
 *            (Aluno/Professor) e "Sair".
 * Anônimo  → menu com "Entrar" e "Criar conta" apontando para login.html.
 *
 * Idempotente e tolerante: sem o botão na página, não faz nada (os testes
 * Jest importam módulos sem o DOM das páginas).
 */
export function iniciarUiPerfil(root = document) {
  const botao = root.querySelector?.("#profileButton");
  if (!botao) return null;
  if (botao.dataset.perfilIniciado === "1") return null;
  botao.dataset.perfilIniciado = "1";

  const wrapper = document.createElement("div");
  wrapper.className = "profile-wrapper";
  botao.parentNode?.insertBefore(wrapper, botao);
  wrapper.appendChild(botao);

  const menu = document.createElement("div");
  menu.className = "profile-menu hidden";
  menu.id = "profileMenu";
  wrapper.appendChild(menu);

  function desenharMenu() {
    const usuario = usuarioAtual();

    if (usuario) {
      botao.textContent = inicialDoNome(usuario);
      botao.classList.add("profile-avatar");
      botao.setAttribute(
        "aria-label",
        `Perfil de ${usuario.nome || "usuário"} — abrir menu`
      );
      menu.innerHTML = `
        <div class="profile-identity">
          <strong>${escaparHtml(usuario.nome || "Usuário")}</strong>
          <span>${escaparHtml(usuario.email || "")}</span>
          ${rotuloTipo(usuario)
            ? `<span class="role-badge ${escaparHtml(usuario.tipo_usuario)}">${escaparHtml(rotuloTipo(usuario))}</span>`
            : ""}
        </div>
        <button type="button" class="profile-action" id="logoutButton">Sair da conta</button>
      `;
      menu.querySelector("#logoutButton")?.addEventListener("click", () => {
        logout();
        window.location.href = "./home.html";
      });
      return;
    }

    botao.textContent = "👤";
    botao.classList.remove("profile-avatar");
    botao.setAttribute("aria-label", "Entrar ou criar conta");
    menu.innerHTML = `
      <div class="profile-identity">
        <strong>Você não está logado</strong>
        <span>Entre para receber recomendações personalizadas.</span>
      </div>
      <a class="profile-action" href="./login.html">Entrar</a>
      <a class="profile-action" href="./login.html?modo=cadastro">Criar conta</a>
    `;
  }

  function fechar() {
    menu.classList.add("hidden");
  }

  function alternar() {
    const vaiAbrir = menu.classList.contains("hidden");
    desenharMenu();
    menu.classList.toggle("hidden", !vaiAbrir);
  }

  botao.addEventListener("click", (event) => {
    event.stopPropagation();
    alternar();
  });

  document.addEventListener("click", (event) => {
    if (!wrapper.contains(event.target)) fechar();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") fechar();
  });

  desenharMenu();
  return { botao, menu };
}
