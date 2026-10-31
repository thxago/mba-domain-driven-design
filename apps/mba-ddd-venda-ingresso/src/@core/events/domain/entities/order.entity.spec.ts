import { OrderCancelled } from '../events/domain-events/order-cancelled.event';
import { CustomerId } from './customer.entity';
import { EventSpotId } from './event-spot';
import { Order, OrderStatus } from './order.entity';

describe('Order.cancel', () => {
  test.each([
    ['pending', false],
    ['paid', true],
  ])('cancels a %s order and registers its event', (_, paid) => {
    const order = Order.create({
      customer_id: new CustomerId(),
      event_spot_id: new EventSpotId(),
      amount: 200,
    });
    if (paid) {
      order.pay();
    }
    const previousEvents = [...order.events];

    order.cancel();

    expect(order.status).toBe(OrderStatus.CANCELLED);
    const events = [...order.events];
    expect(events.slice(0, -1)).toEqual(previousEvents);
    expect(events).toHaveLength(previousEvents.length + 1);
    const cancelled = events[events.length - 1] as OrderCancelled;
    expect(cancelled).toBeInstanceOf(OrderCancelled);
    expect(cancelled.aggregate_id).toBe(order.id);
    expect(cancelled.status).toBe(OrderStatus.CANCELLED);
    expect(cancelled.event_spot_id).toBe(order.event_spot_id);
  });

  test('rejects repeated cancellation without changing status or events', () => {
    const order = Order.create({
      customer_id: new CustomerId(),
      event_spot_id: new EventSpotId(),
      amount: 200,
    });
    order.cancel();
    const previousEvents = [...order.events];

    expect(() => order.cancel()).toThrow('Order already cancelled');

    expect(order.status).toBe(OrderStatus.CANCELLED);
    expect([...order.events]).toEqual(previousEvents);
  });
});