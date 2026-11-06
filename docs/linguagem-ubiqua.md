# Linguagem ubíqua — Lista de Espera de Ingressos

Modelo desenhado antes da implementação e refinado para a entrega final, baseado no enunciado da `Lista de Espera de Ingressos` e nos padrões da base. Os nomes abaixo correspondem às classes e operações implementadas.

## Glossário

| Termo                              | Nome no código                                                   | Definição                                                                                                                                                |
| ---------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cliente                            | `Customer` / `CustomerId`                                        | Agregado que identifica quem compra ingressos ou entra na lista de espera. Outros agregados o referenciam por ID.                                        |
| Pedido                             | `Order` / `OrderId`                                              | Agregado da compra, associado ao cliente e ao lugar por ID; controla seu status e a invariante de cancelamento único.                                    |
| Cancelar pedido                    | `CancelOrderService.cancel(order_id)` / `Order.cancel()`         | O serviço carrega o pedido e delega ao agregado a mudança para `CANCELLED` e o registro do evento; não libera o lugar nem notifica a fila.               |
| Pedido cancelado                   | `OrderCancelled`                                                 | Evento de domínio do pedido com `aggregate_id`, `status` e `event_spot_id`, permitindo a reação de liberação sem acoplar agregados.                      |
| Evento de venda de ingressos       | `Event` / `EventId`                                              | Agregado que controla publicação e disponibilidade dos lugares por meio de suas seções e spots; não se confunde com um evento de domínio.                |
| Seção                              | `EventSection` / `EventSectionId`                                | Entidade filha de `Event` que agrupa lugares e define seu preço; identifica, junto com o evento, a fila correspondente.                                  |
| Lugar                              | `EventSpot` / `EventSpotId`                                      | Entidade filha de `EventSection` que representa um lugar, com estado de publicação e reserva; seu ID é conhecido pelo pedido.                            |
| Trava de reserva                   | `SpotReservation`                                                | Agregado separado identificado pelo ID do lugar, que impede uma nova reserva; é removido na reação ao cancelamento.                                      |
| Liberação de lugar                 | `Event.markSpotAsAvailable(spot_id)`                             | Operação da raiz que encontra a seção e desce até o spot para torná-lo não reservado, registrando o evento de liberação.                                 |
| Reação ao cancelamento             | `ReleaseSpotOnOrderCancelledHandler`                             | Handler que localiza `Event` pelo spot do pedido, delega a liberação à raiz, remove a trava existente e publica os eventos do agregado.                  |
| Lugar liberado                     | `EventSpotReleased`                                              | Evento de domínio de `Event` com `event_id`, `section_id` e `spot_id`, que dispara a política da lista de espera.                                        |
| Seção esgotada                     | Estado de reserva via `EventSpot.is_reserved`                    | Seção sem nenhum lugar livre; independe da publicação do evento, da seção ou dos lugares e não usa `total_spots_reserved`.                               |
| Lista de espera                    | `WaitingList` / `WaitingListId`                                  | Agregado separado de `Event`, com uma fila por `event_id` + `section_id`; controla entradas, duplicidade pendente e ordem de notificação.                |
| Entrada na lista                   | `WaitingListEntry` / `WaitingListEntryId`                        | Entidade filha de `WaitingList`, com `customer_id`, status e ordem de chegada, mantida na coleção da raiz via `MyCollectionFactory`.                     |
| Entrada pendente                   | `WaitingListEntryStatus.PENDING`                                 | Estado inicial de uma entrada ainda elegível para notificação (`0` na API); impede outra entrada pendente do mesmo cliente na mesma fila.                |
| Entrada notificada                 | `WaitingListEntryStatus.NOTIFIED`                                | Estado de uma entrada já selecionada pela política (`1` na API); não é notificada novamente, mas não impede uma nova entrada pendente do cliente.        |
| Ordem de chegada                   | `WaitingListEntry.position`                                      | Posição sequencial atribuída após a maior posição existente; a notificação seleciona a menor posição ainda `PENDING`, ignorando as já notificadas.       |
| Entrar na fila                     | `WaitingListService.join(...)` / `WaitingList.join(customer_id)` | O serviço valida cliente, evento, seção e esgotamento; a raiz cria a entrada pendente e impede a duplicidade.                                            |
| Consultar a fila                   | `WaitingListService.list(event_id, section_id)`                  | Consulta sem alteração de estado ou eventos, que retorna entradas ordenadas por posição com seus status, ou array vazio sem fila.                        |
| Cliente entrou na lista            | `CustomerJoinedWaitingList`                                      | Evento de domínio de `WaitingList`, registrado quando uma entrada pendente é criada, com IDs da raiz, cliente, evento e seção.                           |
| Política de notificação            | `NotifyWaitingCustomerOnSpotReleasedHandler`                     | Reação a `EventSpotReleased` que carrega a fila e chama `WaitingList.notifyFirstPending(spot_id)`; sem fila ou pendentes, termina sem efeito e sem erro. |
| Lugar oferecido ao cliente da fila | `SpotOfferedToWaitingCustomer`                                   | Evento de domínio de `WaitingList` com `customer_id`, `event_id`, `section_id` e `spot_id`, registrado ao marcar a primeira entrada como `NOTIFIED`.     |
| Oferta para integração             | `SpotOfferedToWaitingCustomerIntegrationEvent`                   | Evento de integração com os mesmos quatro IDs como strings no payload, destinado a e-mails; não representa reserva, prioridade ou prazo.                 |
| Consumidor de e-mails              | `ConsumerService.handleSpotOffered(...)` em `apps/emails`        | Consome a oferta com `@RabbitSubscribe` na fila `emails-spot-offered` e registra cliente e seção no log estruturado, sem envio real de e-mail.           |

## Fronteiras dos agregados e contextos

`Order` controla o cancelamento; `Event` controla a disponibilidade na cadeia `Event` → `EventSection` → `EventSpot`; `SpotReservation` mantém a trava separada; `WaitingList` controla suas entradas. `Customer` é consultado para validar a entrada e referenciado por ID. Nenhum agregado guarda outro agregado por objeto.

A fila fica fora de `Event` porque suas invariantes dizem respeito à duplicidade de clientes pendentes e à ordenação de entradas, não à estrutura ou à publicação dos lugares. Incluí-la em `Event` aumentaria o agregado e acoplaria toda alteração da fila ao carregamento do evento. A coordenação entre essas fronteiras ocorre por eventos de domínio e handlers, sem transformar o comando de cancelamento em uma operação sobre todos os agregados.

O contexto de venda de ingressos emite a oferta para integração. O contexto de e-mails a consome pelo caminho já existente: Bull `integration-events` → `IntegrationEventsPublisher` → RabbitMQ `amq.direct` → fila `emails-spot-offered` → `ConsumerService.handleSpotOffered`. A routing key é `SpotOfferedToWaitingCustomerIntegrationEvent`; a assinatura de parceiros permanece na fila `emails`.

## Fluxos e regras do modelo

**Entrada:** cliente → `WaitingListService.join(...)` valida cliente, evento, seção e esgotamento → `WaitingList.join(customer_id)` cria uma entrada `PENDING` → `CustomerJoinedWaitingList`. A raiz impede duplicidade pendente. `WaitingListService.list(...)` retorna entradas por `position` e não dispara notificações.

**Cancelamento:** cliente → `CancelOrderService.cancel(order_id)` → `Order.cancel()` muda para `CANCELLED` → `OrderCancelled` → `ReleaseSpotOnOrderCancelledHandler` localiza `Event` pelo spot, delega a liberação à raiz e remove `SpotReservation` → `EventSpotReleased` → `NotifyWaitingCustomerOnSpotReleasedHandler` carrega `WaitingList` e promove o primeiro pendente → `SpotOfferedToWaitingCustomer` → `SpotOfferedToWaitingCustomerIntegrationEvent` → `ConsumerService.handleSpotOffered`.

Os comandos que registram eventos usam `ApplicationService.run(...)` e incluem os agregados no Unit of Work com `repo.add(...)`. Os handlers persistem os agregados alterados e publicam explicitamente seus eventos. A fila não é promovida diretamente pelo comando, embora os handlers de domínio do mecanismo didático executem em processo; o transporte para e-mails usa a fila de integração existente.

A política apenas avisa: o lugar liberado continua disponível e o cliente notificado compra pelo fluxo normal, sem reserva, prioridade ou expiração. Não há reembolso, pagamento no cancelamento, envio real de e-mail, tratamento de concorrência ou outbox neste modelo.

## Erros de negócio

As mensagens são strings simples em `Error`, preservadas exatamente como no enunciado.

| Situação                                   | Mensagem                           |
| ------------------------------------------ | ---------------------------------- |
| Pedido inexistente                         | `Order not found`                  |
| Pedido já cancelado                        | `Order already cancelled`          |
| Cliente inexistente                        | `Customer not found`               |
| Evento inexistente                         | `Event not found`                  |
| Seção inexistente                          | `Section not found`                |
| Seção com lugar livre, mesmo não publicado | `Section is not sold out`          |
| Cliente com entrada pendente na mesma fila | `Customer already in waiting list` |

## Event storming

O diagrama editável está em [event-storming.excalidraw](event-storming.excalidraw). Para visualizá-lo, abra o arquivo em um editor Excalidraw local ou na integração do IDE; não é necessário publicar o conteúdo em um serviço externo.

Seguindo `Event Storming.png`, azul identifica comandos, laranja eventos de domínio, cinza agregados, amarelo atores e fronteiras, roxo políticas, rosa o sistema externo e verde a consulta. A oferta de integração tem identificação própria e uma seta atravessando a fronteira para e-mails. As setas expressam causalidade, não uma transação distribuída nem chamadas diretas entre comandos e agregados de outras fronteiras.