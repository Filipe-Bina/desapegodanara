# Desapego da Nara

Catálogo de itens da casa por foto, com busca automática de produtos semelhantes na web, sugestão de preço/descrição/condição e preço final decidido por vocês.

## Como usar

1. Instale o Node 18+ e pegue uma chave **gratuita** do Gemini em https://aistudio.google.com (ou, alternativamente, uma da Anthropic em https://console.anthropic.com).
2. No PowerShell, dentro desta pasta:
   ```powershell
   $env:GEMINI_API_KEY="sua-chave"
   node server.js
   ```
   Se existirem as duas chaves, o Gemini é usado. `GEMINI_MODEL` troca o modelo (padrão `gemini-2.5-flash`).
3. Abra o endereço `http://localhost:3000` no PC. O terminal também mostra o endereço para abrir **no celular** (mesmo Wi-Fi), onde o botão "Tirar foto" abre a câmera.

Sem a chave o app funciona como catálogo manual; só a busca automática fica desativada.

## Fluxo

Novo item → fotos → **Buscar na web e sugerir** (título, descrição, condição, faixa de preço e anúncios semelhantes) → ajustam o que quiserem → **seu preço** → Salvar.

## Publicação

- **Vitrine** (`/vitrine.html`): página pública só com itens "Disponível", sem mostrar preço de mercado.
- **Instagram**: botão "Legenda Instagram" copia texto pronto; salvem as fotos e postem.
- Para colocar a vitrine na internet, hospede esta pasta (ex.: Render ou Hostinger) e proteja a tela de edição (`index.html`) antes, pois hoje ela não tem senha.

## Dados

Ficam em `data/items.json` e `data/images/`. Faça backup dessa pasta.
