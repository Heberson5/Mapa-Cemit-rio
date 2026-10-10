# Mapa do Cemitério – Memorial Santa Cruz (Tangará da Serra/MT)

Mapa aéreo 3D do cemitério + sistema de gestão + totem de consulta para visitantes.

## Como rodar
```bash
npm install          # instala maplibre-gl e xlsx
npm run vendor       # copia as libs para public/vendor (o totem não depende de CDN)
ADMIN_PASSWORD='sua-senha' npm start     # Node 22.13+
```
- Totem (tela cheia, toque): `http://localhost:3000/`
- Gestão: `http://localhost:3000/admin.html` (usuário `ADMIN_USER`, padrão `admin`; senha `ADMIN_PASSWORD`, padrão `admin` – **troque**).
- Na 1ª execução o banco (`data/cemiterio.db`, SQLite) recebe **dados de demonstração** (layout fictício). Apague em *Configurações → Apagar dados de demonstração* ou inicie com `NO_DEMO=1`.

## O que tem
**Totem** – tela de boas-vindas → pesquisa NPS/ambiente (pulável) → busca por nome (teclado na tela) → mapa 3D voa até o jazigo, destaca-o, traça a rota desde a entrada e mostra quadra/alameda/lote/gaveta/situação. Reinicia sozinho por inatividade. Cada visualização é registrada.

**Gestão**
- *Consultas*: totais, por dia/mês, horário, **quadra, alameda, tipo de jazigo, falecido, jazigo**, situação, termos sem resultado; filtro por período; CSV; mapa de calor.
- *Mapa / Demarcação*: coloque jazigos clicando (1 ou **N em fileira**, com rotação e espaçamento), desenhe formas livres, mova/gire, demarque os que vieram da planilha sem posição, desenhe o **limite**, a **entrada** e reposicione todo o layout sobre o cemitério real.
- *Jazigos / Falecidos*: CRUD completo; situação **sepultamento / exumação / guarda de cinzas**; gaveta; responsável; telefone.
- *Importar planilha*: `.xlsx`/`.csv`, reconhece variações de títulos, pré-visualiza, **simula** antes de gravar, atualiza sem duplicar, cria jazigos ausentes, lista erros por linha. Há planilha modelo.
- *Pesquisa / NPS*: perguntas cadastráveis (NPS 0–10, estrelas, múltipla escolha, texto) com categorias (ambiente, limpeza, atendimento…); NPS, tendência diária e médias por categoria.

Tipos de jazigo: `1G`, `2G`, `3G`, `3GS` (3 + área de serviço), `6GS` (6 + área de serviço), `FAM` (terreno familiar do anfiteatro, 6 gavetas + área de serviço). Altura 3D proporcional às gavetas.

## Imagem aérea (importante)
O padrão usa Esri World Imagery (gratuita; a data/nitidez dependem do provedor, **não há garantia de ser 2026**). Para imagem atual, nítida e "só do cemitério" (4K, lápides visíveis no gramado) faça um **voo de drone**, gere a ortofoto (ex.: WebODM → XYZ tiles) e informe a URL em *Configurações → URL dos tiles*. O mapa recorta tudo fora do limite desenhado.
