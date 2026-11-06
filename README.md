# MBA Full Cycle - Domain Driven Design — Lista de Espera de Ingressos

Este repositório contém o código-fonte e material didático do curso de Domain Driven Design do MBA Full Cycle.

O projeto é feito com Nestjs, mas o conteúdo é independente de linguagem ou framework.

Esta entrega estende a base [devfullcycle/mba-domain-driven-design](https://github.com/devfullcycle/mba-domain-driven-design) com cancelamento de pedido e lista de espera por seção. O código está consolidado na branch `main` do fork público: **https://github.com/thxago/mba-domain-driven-design**.

## Pré-requisitos

- Node.js 18+
- Docker com engine Linux e Docker Compose
- Portas locais disponíveis: 3000 (API), 3001 (e-mails), 3306 (MySQL), 6379 (Redis), 5672 e 15672 (RabbitMQ)

A entrega foi reproduzida com Node.js 22 e os serviços do [docker-compose.yaml](docker-compose.yaml). As configurações de conexão são as da base, para desenvolvimento local.

## Executar o projeto

Na raiz do repositório, suba MySQL, Redis e RabbitMQ e instale as dependências:

```powershell
docker-compose up -d
npm install
```

Aguarde o MySQL ficar pronto. O projeto não usa migrações: a CLI lê os schemas registrados em [mikro-orm.config.ts](apps/mba-ddd-venda-ingresso/src/mikro-orm.config.ts), incluindo a fila e seus filhos.

**Atenção: o comando abaixo recria todas as tabelas e apaga os dados do banco `events`. Use apenas no ambiente local de desenvolvimento e avaliação.**

```powershell
npx mikro-orm schema:fresh --run
```

Em um terminal, inicie a API:

```powershell
npm run start:dev
```

Em outro terminal, inicie o app de e-mails:

```powershell
npx nest start emails
```

A API responde em `http://localhost:3000` e o app de e-mails em `http://localhost:3001`. Antes de executar o fluxo, aguarde o consumidor registrar a assinatura `amq.direct::SpotOfferedToWaitingCustomerIntegrationEvent::emails-spot-offered` e conectar ao RabbitMQ. Como a inicialização de conexão da base não bloqueia a aplicação, o HTTP disponível sozinho não garante que a assinatura esteja pronta.

## Reproduzir a feature

Abra [api.http](api.http) no HTTP Client do IntelliJ e execute as requisições em ordem. Os scripts de resposta capturam os IDs automaticamente. Em outros clientes, substitua os placeholders pelos IDs retornados; a automação dos scripts é específica do HTTP Client do IntelliJ.

O roteiro cria parceiro, clientes A e B, evento e seção com um lugar; publica o evento e compra com A. Com a seção esgotada, B entra na fila como `PENDING`. Um único cancelamento de A devolve o lugar, remove a trava, marca B como `NOTIFIED` e gera o log `ConsumerService.handleSpotOffered` no terminal de e-mails. A fila é ordenada por `position`, independentemente dos contadores de reservas.

| Operação                | Endpoint                                                     | Corpo / resposta                                     |
| ----------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| Cancelar pedido pelo ID | `POST /events/{event_id}/orders/{order_id}/cancel`           | Sem corpo; retorna o pedido com `status`             |
| Entrar na fila          | `POST /events/{event_id}/sections/{section_id}/waiting-list` | `{ "customer_id": "..." }`; retorna a entrada criada |
| Consultar a fila        | `GET /events/{event_id}/sections/{section_id}/waiting-list`  | Array de entradas ordenadas, ou `[]` sem fila        |

Os status expostos são numéricos: pedido `PENDING = 0`, `PAID = 1`, `CANCELLED = 2`; entrada `PENDING = 0`, `NOTIFIED = 1`. A resposta dos spots usa `reserved`, correspondente a `is_reserved` no domínio e no banco.

Para inspecionar os eventos publicados no MySQL, abra o cliente com a senha configurada no Compose:

```powershell
docker-compose exec mysql mysql -uroot -p events
```

```sql
SELECT type_name FROM stored_event;
```

Após o roteiro, devem existir `CustomerJoinedWaitingList`, `OrderCancelled`, `EventSpotReleased` e `SpotOfferedToWaitingCustomer`, além de `PartnerCreated`. Um evento apenas registrado no agregado, mas não publicado, não aparece nessa tabela.

## Testes

**Pare a API antes de rodar a suíte completa.** Os testes de infraestrutura herdados usam MySQL real e `orm.schema.refreshDatabase()` no banco `events`: podem apagar dados e remover `stored_event`, pois registram apenas os schemas do cenário.

```powershell
npm test
```

Os novos testes que precisam de MySQL usam bancos temporários de nomes únicos no mesmo servidor e os removem ao finalizar. O teste [waiting-list-flow.spec.ts](apps/mba-ddd-venda-ingresso/src/@core/events/application/waiting-list-flow.spec.ts) registra ambos os handlers e o mapeamento pelo `EventsModule.onModuleInit` real, dispara o caso de uso e verifica lugar disponível, trava removida, somente o primeiro pendente notificado, eventos armazenados e oferta enfileirada. Apenas a Bull é substituída nesse teste em processo; o roteiro HTTP verifica também Redis, RabbitMQ e o consumidor reais.

Para executar somente o teste da cadeia:

```powershell
npm test -- --runTestsByPath 'apps\mba-ddd-venda-ingresso\src\@core\events\application\waiting-list-flow.spec.ts'
```

**Após a suíte completa, recrie o schema antes de reiniciar a API** com `npx mikro-orm schema:fresh --run`. Esse comando também apaga os dados dos testes e do roteiro anterior. Na validação desta entrega, passaram 58 testes em 22 suítes; os 2 testes já skipped na base permaneceram skipped. O roteiro HTTP passou com 23 requisições e 7 verificações.

## Fronteira de WaitingList

`WaitingList` é um agregado separado de `Event` porque suas invariantes são a duplicidade de clientes pendentes e a ordem de promoção, enquanto `Event` controla publicação e disponibilidade na cadeia `Event` → `EventSection` → `EventSpot`. Colocar todas as entradas dentro de `Event` aumentaria o tamanho do agregado e acoplaria alterações da fila ao carregamento de seções e lugares. A fila referencia evento, seção e clientes por IDs; uma restrição única garante uma lista por evento + seção. A coordenação entre agregados acontece por eventos de domínio, sem ampliar o comando de cancelamento para manipular todas essas fronteiras.

## Cadeia do cancelamento

O POST de cancelamento chama `CancelOrderService.cancel`, que executa via `ApplicationService.run(...)`, chama `Order.cancel()` e inclui o pedido no Unit of Work para publicar `OrderCancelled`. `ReleaseSpotOnOrderCancelledHandler` reage buscando `Event` pelo spot, chama a operação da raiz que desce pelas entidades filhas, remove `SpotReservation` e publica `EventSpotReleased`. `NotifyWaitingCustomerOnSpotReleasedHandler` reage carregando `WaitingList`, promove somente o primeiro `PENDING` e publica `SpotOfferedToWaitingCustomer`, tanto para domínio quanto para integração. O mapeamento do `EventsModule` cria `SpotOfferedToWaitingCustomerIntegrationEvent` com os quatro IDs e adiciona à Bull `integration-events`; o `IntegrationEventsPublisher` existente publica na exchange `amq.direct`, com o nome do evento como routing key. `ConsumerService.handleSpotOffered`, em `apps/emails`, consome pela fila `emails-spot-offered` e registra cliente e seção no log estruturado.

## Limitações e escopo

O mecanismo didático da base foi preservado. Os handlers de domínio executam em processo, por reação a eventos; não são chamadas diretas dentro do comando, mas também não representam uma fila assíncrona de domínio. `ApplicationService` publica os eventos de domínio antes do commit e depois publica os de integração dos agregados capturados pelo Unit of Work. A política publica explicitamente sua integração durante a reação; portanto, não há atomicidade entre gravação no banco e enfileiramento, outbox ou garantia de recuperação após falhas. O manager também não limpa automaticamente os eventos dos agregados. Essas limitações não foram contornadas com uma reescrita do mecanismo.

A política apenas notifica: o lugar continua disponível para compra pelo fluxo normal, sem reserva para o cliente avisado, prioridade ou expiração. Sem fila ou pendentes, não há oferta nem erro. Uma entrada `NOTIFIED` não é notificada novamente; o cliente pode entrar novamente se não tiver outra entrada pendente na mesma fila. Não há reembolso, pagamento no cancelamento, envio real de e-mail, tratamento de concorrência, frontend, autenticação ou padronização de códigos HTTP de erro.

O esgotamento é derivado de `EventSpot.is_reserved`, independentemente da publicação do evento, da seção ou dos lugares, não de `total_spots_reserved`, que a compra existente não mantém. `Event.allowReserveSpot(...)` continua controlando a elegibilidade para compra, que também exige publicação; essa condição não define esgotamento. Os novos modelos não recebem decorators de framework; usam os `EntitySchema`, custom types e `MyCollectionFactory` herdados. A abstração de coleções da base já depende de metadados do MikroORM e foi preservada; testes puros dos novos comportamentos com filhos substituem somente essa coleção por uma implementação em memória.

## Design estratégico

- [Event storming editável](docs/event-storming.excalidraw): comandos, agregados, eventos, políticas e fronteira de integração com e-mails.
- [Linguagem ubíqua](docs/linguagem-ubiqua.md): termos e nomes efetivamente usados no código, regras e fronteiras.

O diagrama foi desenhado antes da implementação e refinado para representar a entrega final, seguindo a legenda de cores de `Event Storming.png`. Abra-o em um editor Excalidraw local ou na integração do IDE.

## Professor

<a href="https://github.com/argentinaluiz">
    <img src="https://avatars.githubusercontent.com/u/4926329?v=4?s=100" width="100px;" alt=""/>
    <br />
    <sub>
        <b>Luiz Carlos</b>
    </sub>
</a>
