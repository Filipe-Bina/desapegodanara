# Desapego da Nara

Catálogo de itens da casa por foto, com busca automática de produtos semelhantes na web, sugestão de preço/descrição/condição e preço final decidido por vocês.

## Como usar

1. Instale o Node 18+ e pegue uma chave **gratuita** do Gemini em https://aistudio.google.com (ou, alternativamente, uma da Anthropic em https://console.anthropic.com).
2. No PowerShell, dentro desta pasta:
   ```powershell
   $env:GEMINI_API_KEY="sua-chave"
   node server.js
   ```
   Também aceita `OPENROUTER_API_KEY` (modelos gratuitos, sem busca na web; `OPENROUTER_MODEL` fixa um modelo). A ordem de tentativa é Gemini, depois OpenRouter, depois Anthropic: se uma falhar, passa para a próxima. `GEMINI_MODEL` troca o modelo (padrão `gemini-3.8-flash`).
3. Abra o endereço `http://localhost:3000` no PC. O terminal também mostra o endereço para abrir **no celular** (mesmo Wi-Fi), onde o botão "Tirar foto" abre a câmera.

Sem a chave o app funciona como catálogo manual; só a busca automática fica desativada.

## Divulgação

- Em **Configurações** (ícone de ajustes) vocês colocam o WhatsApp de contato, a cidade de retirada e o nome da vitrine.
- Em cada item, **Compartilhar** gera um card com foto, título e preço (para o Instagram) e uma legenda pronta. No celular, o WhatsApp envia as fotos com a legenda.
- A **vitrine** (`/vitrine.html`) tem um botão "Tenho interesse" que abre o WhatsApp já com o nome do item. Cada item tem link próprio (`/vitrine.html#id`).

## Fluxo

Novo item → fotos → **Buscar na web e sugerir** (título, descrição, condição, faixa de preço e anúncios semelhantes) → ajustam o que quiserem → **seu preço** → Salvar.

## Publicação

- **Vitrine** (`/vitrine.html`): página pública só com itens "Disponível", sem mostrar preço de mercado.
- **Instagram**: botão "Legenda Instagram" copia texto pronto; salvem as fotos e postem.
- Para colocar a vitrine na internet, hospede esta pasta (ex.: Render ou Hostinger) e proteja a tela de edição (`index.html`) antes, pois hoje ela não tem senha.

## Dados

Ficam em `data/items.json` e `data/images/`. Faça backup dessa pasta.
