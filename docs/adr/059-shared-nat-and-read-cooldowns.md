# ADR-059 — Limites por usuário e recuperação de leituras HTTP 429

Data: 16/10/2026. Complemento de funcionamento da aplicação, associado a R15/R23.

## Falha reproduzida

A [CI 38903556681](https://github.com/matheuscoutinhoo/shNet/actions/runs/38903556681) aprovou regressão, capacidade, containers e navegador escuro. No navegador claro, o cenário PAT/ACL salvou o projeto, mas a reabertura recebeu HTTP 429. O trace mostrou duas leituras de atividades e uma leitura de projeto limitadas; a tela permaneceu na lista com o erro e o cenário esgotou seu tempo aguardando o canvas. Não foi um defeito de eleição ou de NAT simulado.

O orçamento geral da API usava somente IP. Usuários distintos atrás do mesmo NAT podiam consumir a cota uns dos outros. O cliente também recusava imediatamente uma leitura mesmo quando o servidor instruía uma espera curta de um segundo.

## Decisão e implementação

O orçamento geral mantém o valor configurado de 300 requisições/minuto por padrão, mas usa a identidade do usuário quando uma sessão é validada no banco. Sessões diferentes do mesmo usuário compartilham a cota, inclusive entre instâncias da API. Outros usuários no mesmo IP recebem cotas independentes. Cookie ausente, inválido ou revogado usa a cota de IP; trocar texto de cookie não cria novas cotas.

As rotas de autenticação continuam usando IP, mesmo com cookie válido. A decisão utiliza a rota canônica resolvida pelo servidor. Os limites específicos existentes, incluindo oito tentativas/minuto no login, permanecem ativos e compartilhados no PostgreSQL. Não há cache de autorização nem identidade derivada apenas do texto de um cookie.

No cliente, somente GET recebe até duas repetições adicionais após 429 com `Retry-After` válido de até três segundos. Aceitamos segundos inteiros ou data HTTP. Cada repetição espera o intervalo indicado; todas as tentativas e esperas compartilham o deadline original de 30 segundos. O corpo anterior é liberado antes da repetição. Cancelamento durante a espera encerra o timer. Header ausente, inválido ou longo mantém o erro explícito. POST/PUT/PATCH/DELETE não são repetidos automaticamente.

A cota específica de registro de visitas também não deve bloquear um projeto cuja leitura foi autorizada: a abertura prossegue se somente esse POST receber 429. Não há repetição do POST nem registro fictício de atividade. Falhas de autenticação, ownership e servidor continuam impedindo a abertura.

## Aceites

- Dois usuários no mesmo IP têm cotas independentes; duas sessões do mesmo usuário e duas instâncias compartilham a mesma cota.
- Cookies inválidos alternados continuam na mesma cota de IP.
- Alternar cookies válidos não evita o limite de login por IP.
- GET respeita o intervalo e o máximo de tentativas; erro persistente, deadline, formato de resposta e CSRF continuam verificados.
- O E2E de quorum injeta 429 com espera de um segundo na leitura e 429 no registro da visita, exigindo abrir o projeto sem nova ação do usuário e sem repetir o POST. O cenário PAT/ACL original conserva seus asserts e timeout.

O escopo de validação e a versão efetivamente publicada constam na evidência do incremento. Não há desativação de limites para fazer a suíte passar. Cadastros, login e acessos anônimos continuam sujeitos aos limites por IP, inclusive em redes compartilhadas.
