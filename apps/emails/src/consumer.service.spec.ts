import { AmqpConnection } from '@golevelup/nestjs-rabbitmq';
import { Job } from 'bull';
import { ConsumerService } from './consumer.service';
import { IntegrationEventsPublisher } from '../../mba-ddd-venda-ingresso/src/domain-events/integration-events.publisher';
import { IIntegrationEvent } from '../../mba-ddd-venda-ingresso/src/@core/common/domain/integration-event';
import { CustomerId } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/entities/customer.entity';
import { EventId } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/entities/event.entity';
import { EventSectionId } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/entities/event-section';
import { EventSpotId } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/entities/event-spot';
import { WaitingListId } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/entities/waiting-list.entity';
import { SpotOfferedToWaitingCustomer } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/events/domain-events/spot-offered-to-waiting-customer.event';
import { SpotOfferedToWaitingCustomerIntegrationEvent } from '../../mba-ddd-venda-ingresso/src/@core/events/domain/events/integration-events/spot-offered-to-waiting-customer.int-events';

test('publishes the serialized offer on the existing routing key and logs customer and section', async () => {
  const domainEvent = new SpotOfferedToWaitingCustomer(
    new WaitingListId(),
    new CustomerId(),
    new EventId(),
    new EventSectionId(),
    new EventSpotId(),
  );
  const integration = new SpotOfferedToWaitingCustomerIntegrationEvent(
    domainEvent,
  );
  const data = JSON.parse(JSON.stringify(integration));
  const consumer = new ConsumerService();
  const log = jest.spyOn(console, 'log').mockImplementation(jest.fn());
  const publish = jest.fn().mockResolvedValue(undefined);
  const publisher = new IntegrationEventsPublisher({
    publish,
  } as unknown as AmqpConnection);

  try {
    await publisher.handle({ data } as Job<IIntegrationEvent>);

    expect(publish).toHaveBeenCalledWith(
      'amq.direct',
      'SpotOfferedToWaitingCustomerIntegrationEvent',
      data,
    );
    consumer.handleSpotOffered(data);
    expect(log).toHaveBeenCalledWith('ConsumerService.handleSpotOffered', {
      event_name: integration.event_name,
      customer_id: domainEvent.customer_id.value,
      event_id: domainEvent.event_id.value,
      section_id: domainEvent.section_id.value,
      spot_id: domainEvent.spot_id.value,
    });
    expect(integration.event_version).toBe(domainEvent.event_version);
  } finally {
    log.mockRestore();
  }
});