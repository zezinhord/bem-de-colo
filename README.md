# Bem de Colo — conta familiar e sincronização

Aplicativo web responsivo e instalável (PWA) para acompanhar rotina do bebê, controlar suprimentos e planejar despesas e metas. Esta edição inclui acesso privado para dois responsáveis, sincronização pela internet e funcionamento local quando a conexão cai.

## 1. Preparar o Supabase (uma única vez)

1. Entre no painel do projeto Supabase.
2. Abra **SQL Editor** → **New query**.
3. Abra `supabase/schema.sql`, copie todo o conteúdo e execute.
4. Confirme que foram criadas as tabelas `families`, `family_members` e `family_state`.
5. Em **Authentication** → **URL Configuration**, configure o endereço HTTPS em que o aplicativo será publicado como **Site URL** e inclua esse mesmo endereço na lista de **Redirect URLs**. Isso é necessário para a confirmação do e-mail retornar ao aplicativo.

O SQL habilita RLS, restringe o acesso aos membros da família, configura o Realtime da tabela compartilhada e cria funções de criação/entrada. As funções com privilégios elevados ficam no schema `private`; o aplicativo chama somente wrappers `SECURITY INVOKER` no schema `public`. Não inclua o schema `private` em **Exposed schemas** da API.

## 2. Criar e conectar os dois acessos

1. Publique a pasta `Bem-de-Colo` em um endereço HTTPS (por exemplo, GitHub Pages ou Netlify).
2. Abra o endereço no primeiro celular, toque em **Criar cadastro** e informe e-mail e senha.
3. Se a confirmação de e-mail estiver ativa no Supabase, confirme a mensagem recebida e depois entre no aplicativo.
4. Crie a conta familiar e anote o código de convite exibido.
5. No segundo celular, crie outro cadastro com outro e-mail, confirme-o se necessário, entre e informe o código em **Entrar com convite**.
6. Instale a PWA nos dois aparelhos pelo menu do Chrome: **Instalar app** ou **Adicionar à tela inicial**.

A conta familiar aceita até dois usuários. Cada usuário tem seu próprio login; o código é usado apenas para vincular o segundo responsável.

## 3. Como a sincronização funciona

- Rotina, perfil do bebê, estoque, lista de compras, metas e despesas são salvos no navegador e enviados à tabela `family_state`.
- Alterações feitas pelo outro aparelho são recebidas pelo Supabase Realtime.
- Sem internet, os dados continuam sendo salvos localmente. Quando a conexão retorna, o aplicativo tenta sincronizar novamente.
- O botão **Conta familiar** permite consultar/copiar o convite e sair da conta.
- **Privacidade e dados** permite exportar uma cópia JSON.

### Limite de concorrência desta versão

A aplicação original guarda o conjunto de dados em um único estado JSON. A sincronização preserva registros novos com IDs diferentes, mas duas edições simultâneas do mesmo item/campo ainda podem resultar na prevalência da última gravação. Não editem o mesmo item ao mesmo tempo em aparelhos diferentes. Uma evolução futura pode normalizar os registros em tabelas separadas e adotar resolução de conflito por registro.

## 4. Configuração e segurança

- `supabase-config.js` contém o Project URL e a chave **publishable** fornecida para este aplicativo. Essa chave é pública por definição; a segurança depende das políticas RLS do SQL.
- Nunca coloque `sb_secret_`, `service_role`, senha do banco ou credenciais administrativas em arquivos do aplicativo.
- A autenticação do Supabase persiste a sessão no navegador. Use senha exclusiva e mantenha os celulares protegidos por bloqueio de tela.
- O armazenamento local desta PWA usa `localStorage` e **não tem criptografia própria em repouso**. Não use aparelho compartilhado/desprotegido para esses registros.
- O aplicativo não envia dados para terceiros além do projeto Supabase configurado. A configuração e a política de privacidade do projeto devem ser revisadas pelos responsáveis.

## 5. Instalação e APK

Esta pasta é uma **PWA**, não um projeto Android nativo. Para uso imediato, publique em HTTPS e instale pelo Chrome nos dois aparelhos. O ZIP não contém um APK compilado. A geração de APK exige empacotar a PWA (por exemplo, com Bubblewrap/TWA) e configurar assinatura Android; essa etapa é separada da integração Supabase.

## Conteúdo implementado

- Registro de trocas de fralda, alimentação e sono.
- Desconto automático de fralda cadastrada a cada troca.
- Ponto de reposição e lista de compras.
- Confirmação de compra com reposição e lançamento de despesa.
- Metas do Cofre, aportes e despesas categorizadas.
- Gráficos de estoque, despesas e progresso das metas.
- Tema escuro, exportação JSON, PWA e persistência local.
- Conta privada para dois responsáveis, acesso autenticado, RLS e sincronização em tempo real.

As previsões são estimativas e não substituem orientação pediátrica ou financeira profissional.
