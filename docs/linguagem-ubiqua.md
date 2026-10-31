# Linguagem ubíqua — Lista de Espera de Ingressos

Modelo planejado antes da implementação, baseado no enunciado da `Lista de Espera de Ingressos` e nos padrões da base. Os nomes novos abaixo são contratos de linguagem para as próximas tasks, não classes já implementadas.

## Glossário

| Termo | Nome no código | Definição |
|---|---|---|
| Cliente | `Customer` / `CustomerId` | Agregado que identifica quem compra ingressos ou entra na lista de espera. Outros agregados o referenciam por ID. |
| Pedido | `Order` / `OrderId` | Agregado da compra, associado ao cliente e ao lugar por ID; controla seu status e a invariante de cancelamento único. |
| Cancelar pedido | `Order.cancel()` | Operação que muda um pedido pago ou pendente para `CANCELLED` e registra seu cancelamento; não libera o lugar nem notifica a fila. |
| Pedido cancelado | `OrderCancelled` | Evento de domínio do pedido com `aggregate_id`, `status` e `event_spot_id`, permitindo a reação de liberação sem acoplar agregados. |
| Evento de venda de ingressos | `Event` / `EventId` | Agregado que controla publicação e disponibilidade dos lugares por meio de suas seções e spots; não se confunde com um evento de domínio. |
| Seção | `EventSection` / `EventSectionId` | Entidade filha de `Event` que agrupa lugares e define seu preço; identifica, junto com o evento, a fila correspondente. |
| Lugar | `EventSpot` / `EventSpotId` | Entidade filha de `EventSection` que representa um lugar, com estado de publicação e reserva; seu ID é conhecido pelo pedido. |
| Trava de reserva | `SpotReservation` | Agregado separado identificado pelo ID do lugar, que impede uma nova reserva; é removido na reação ao cancelamento. |
| Liberação de lugar | `Event.markSpotAsAvailable(spot_id)` | Operação planejada na raiz que encontra a seção e desce até o spot para torná-lo não reservado, registrando o evento de liberação. |
| Lugar liberado | `EventSpotReleased` | Evento de domínio de `Event` com `event_id`, `section_id` e `spot_id`, que dispara a política da lista de espera. |
| Seção esgotada | Disponibilidade via `Event.allowReserveSpot(...)` | Seção sem nenhum lugar disponível para reserva; a condição é derivada da disponibilidade real, não de `total_spots_reserved`. |
| Lista de espera | `WaitingList` / `WaitingListId` | Agregado planejado, separado de `Event`, com uma fila por `event_id` + `section_id`; controla entradas, duplicidade pendente e ordem de notificação. |
| Entrada na lista | `WaitingListEntry` / `WaitingListEntryId` | Entidade filha planejada de `WaitingList`, com `customer_id`, status e ordem de chegada, mantida na coleção da raiz via `MyCollectionFactory`. |
| Entrada pendente | `PENDING` | Estado inicial de uma entrada ainda elegível para notificação; impede outra entrada pendente do mesmo cliente na mesma fila. |
| Entrada notificada | `NOTIFIED` | Estado de uma entrada já selecionada pela política; ela não é notificada novamente, mas não impede uma nova entrada pendente do cliente. |
| Ordem de chegada | Ordenação das `WaitingListEntry` | Ordem preservada ao entrar e ao recarregar a fila; a notificação seleciona a primeira entrada ainda `PENDING`, ignorando as já notificadas. |
| Cliente entrou na lista | `CustomerJoinedWaitingList` | Evento de domínio planejado de `WaitingList`, registrado quando uma entrada pendente é criada com sucesso. |
| Política de notificação | Handler de `EventSpotReleased` | Reação planejada que carrega a fila da seção e pede ao agregado que notifique o primeiro pendente; sem fila ou pendentes, termina sem efeito e sem erro. |
| Lugar oferecido ao cliente da fila | `SpotOfferedToWaitingCustomer` | Evento de domínio planejado de `WaitingList` com `customer_id`, `event_id`, `section_id` e `spot_id`, registrado ao marcar a primeira entrada como `NOTIFIED`. |
| Oferta para integração | `SpotOfferedToWaitingCustomerIntegrationEvent` | Evento de integração planejado com os mesmos quatro IDs no payload, destinado ao contexto de e-mails; não representa reserva, prioridade ou prazo. |
| Consumidor de e-mails | `ConsumerService` em `apps/emails` | Consumidor RabbitMQ que receberá a oferta por uma assinatura própria e registrará cliente e seção em um log estruturado, sem envio real de e-mail. |

## Fronteiras dos agregados e contextos

`Order` controla o cancelamento; `Event` controla a disponibilidade na cadeia `Event` → `EventSection` → `EventSpot`; `SpotReservation` mantém a trava separada; `WaitingList` controla suas entradas. `Customer` é consultado para validar a entrada e referenciado por ID. Nenhum agregado guarda outro agregado por objeto.

A fila fica fora de `Event` porque suas invariantes dizem respeito à duplicidade de clientes pendentes e à ordenação de entradas, não à estrutura ou à publicação dos lugares. Incluí-la em `Event` aumentaria o agregado e acoplaria toda alteração da fila ao carregamento do evento. A coordenação entre essas fronteiras ocorre por eventos de domínio e handlers, sem transformar o comando de cancelamento em uma operação sobre todos os agregados.

O contexto de venda de ingressos emite a oferta para integração. O contexto de e-mails a consome pelo caminho já existente: Bull `integration-events` → `IntegrationEventsPublisher` → RabbitMQ `amq.direct` → `ConsumerService`. A routing key é `SpotOfferedToWaitingCustomerIntegrationEvent`.

## Fluxos e regras do modelo

**Entrada:** cliente → entrar na fila → validar cliente, evento, seção e esgotamento no application service → `WaitingList` cria uma entrada `PENDING` → `CustomerJoinedWaitingList`. A raiz impede duplicidade pendente. A consulta retorna entradas na ordem de chegada e não dispara notificações.

**Cancelamento:** cliente → cancelar pedido → `Order` muda para `CANCELLED` → `OrderCancelled` → handler de liberação localiza `Event` pelo spot, delega a liberação à raiz e remove `SpotReservation` → `EventSpotReleased` → política carrega `WaitingList` e promove o primeiro pendente → `SpotOfferedToWaitingCustomer` → evento de integração → consumidor de e-mails.

Os comandos que registram eventos usam `ApplicationService.run(...)` e incluem os agregados no Unit of Work com `repo.add(...)`. Os handlers persistem os agregados alterados e publicam explicitamente seus eventos. A fila não é promovida diretamente pelo comando, embora os handlers de domínio do mecanismo didático executem em processo; o transporte para e-mails usa a fila de integração existente.

A política apenas avisa: o lugar liberado continua disponível e o cliente notificado compra pelo fluxo normal, sem reserva, prioridade ou expiração. Não há reembolso, pagamento no cancelamento, envio real de e-mail, tratamento de concorrência ou outbox neste modelo.

## Erros de negócio

As mensagens são strings simples em `Error`, preservadas exatamente como no enunciado.

| Situação | Mensagem |
|---|---|
| Pedido inexistente | `Order not found` |
| Pedido já cancelado | `Order already cancelled` |
| Cliente inexistente | `Customer not found` |
| Evento inexistente | `Event not found` |
| Seção inexistente | `Section not found` |
| Seção com lugar disponível para reserva | `Section is not sold out` |
| Cliente com entrada pendente na mesma fila | `Customer already in waiting list` |

## Event storming

O diagrama editável está em [event-storming.excalidraw](event-storming.excalidraw). Para visualizá-lo, abra o arquivo em um editor Excalidraw local ou na integração do IDE; não é necessário publicar o conteúdo em um serviço externo.

Seguindo `Event Storming.png`, azul identifica comandos, laranja eventos de domínio, cinza agregados, amarelo atores e fronteiras, roxo políticas, rosa o sistema externo e verde a consulta. A oferta de integração tem identificação própria e uma seta atravessando a fronteira para e-mails. As setas expressam causalidade, não uma transação distribuída nem chamadas diretas entre comandos e agregados de outras fronteiras.