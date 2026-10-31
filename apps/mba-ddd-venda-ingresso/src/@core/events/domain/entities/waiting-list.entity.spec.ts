import { CustomerJoinedWaitingList } from '../events/domain-events/customer-joined-waiting-list.event';
import { SpotOfferedToWaitingCustomer } from '../events/domain-events/spot-offered-to-waiting-customer.event';
import { CustomerId } from './customer.entity';
import { EventSectionId } from './event-section';
import { EventSpot, EventSpotId } from './event-spot';
import { EventId } from './event.entity';
import {
  WaitingListEntry,
  WaitingListEntryStatus,
} from './waiting-list-entry.entity';
import { WaitingList } from './waiting-list.entity';

jest.mock('../../../common/domain/my-collection', () => ({
  MyCollectionFactory: {
    create: () => {
      const items = new Set<object>();
      return {
        add: (...entries: object[]) =>
          entries.forEach((entry) => items.add(entry)),
        find: (predicate: (item: object) => boolean) =>
          [...items].find(predicate),
        values: () => [...items],
      };
    },
  },
}));

describe('WaitingList', () => {
  let list: WaitingList;

  beforeEach(() => {
    list = WaitingList.create({
      event_id: new EventId(),
      section_id: new EventSectionId(),
    });
  });

  test('joins customers as pending in arrival order and registers their events', () => {
    const customer = new CustomerId();

    const first = list.join(customer);
    const second = list.join(new CustomerId());

    expect(first.position).toBe(1);
    expect(second.position).toBe(2);
    expect(first.status).toBe(WaitingListEntryStatus.PENDING);
    expect(second.status).toBe(WaitingListEntryStatus.PENDING);
    expect(list.entries.values()).toEqual([first, second]);
    const events = [...list.events];
    expect(events).toHaveLength(2);
    expect(events[0]).toBeInstanceOf(CustomerJoinedWaitingList);
    expect(events[0]).toMatchObject({
      aggregate_id: list.id,
      customer_id: customer,
      event_id: list.event_id,
      section_id: list.section_id,
    });
  });

  test('rejects a duplicate pending customer by ID without adding an entry or event', () => {
    const customer = new CustomerId();
    const first = list.join(customer);
    const events = [...list.events];

    expect(() => list.join(new CustomerId(customer.value))).toThrow(
      'Customer already in waiting list',
    );

    expect(list.entries.values()).toEqual([first]);
    expect([...list.events]).toEqual(events);
  });

  test('notifies only the first pending entry and registers the offered spot', () => {
    const first = list.join(new CustomerId());
    const second = list.join(new CustomerId());
    const spot = EventSpot.create();
    spot.publish();
    const previousEvents = [...list.events];

    list.notifyFirstPending(spot.id);

    expect(first.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(second.status).toBe(WaitingListEntryStatus.PENDING);
    const events = [...list.events];
    expect(events.slice(0, -1)).toEqual(previousEvents);
    expect(events).toHaveLength(previousEvents.length + 1);
    expect(events[events.length - 1]).toBeInstanceOf(
      SpotOfferedToWaitingCustomer,
    );
    expect(events[events.length - 1]).toMatchObject({
      aggregate_id: list.id,
      customer_id: first.customer_id,
      event_id: list.event_id,
      section_id: list.section_id,
      spot_id: spot.id,
    });
    expect(spot.is_reserved).toBe(false);
    expect(spot.is_published).toBe(true);
  });

  test('skips notified entries and allows the same customer to rejoin at the end', () => {
    const customer = new CustomerId();
    const first = list.join(customer);
    const second = list.join(new CustomerId());
    list.notifyFirstPending(new EventSpotId());

    const rejoined = list.join(new CustomerId(customer.value));
    list.notifyFirstPending(new EventSpotId());

    expect(first.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(second.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(rejoined.status).toBe(WaitingListEntryStatus.PENDING);
    expect(rejoined.position).toBe(3);
    const offers = [...list.events].filter(
      (event) => event instanceof SpotOfferedToWaitingCustomer,
    );
    expect(offers).toHaveLength(2);
    expect(offers[1]).toMatchObject({ customer_id: second.customer_id });
  });

  test('does nothing when the list is empty', () => {
    expect(() => list.notifyFirstPending(new EventSpotId())).not.toThrow();

    expect(list.entries.values()).toEqual([]);
    expect(list.events.size).toBe(0);
  });

  test('does not notify an already notified entry again', () => {
    const entry = list.join(new CustomerId());
    list.notifyFirstPending(new EventSpotId());
    const events = [...list.events];

    list.notifyFirstPending(new EventSpotId());

    expect(entry.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect([...list.events]).toEqual(events);
  });

  test('uses stored positions for promotion, serialization and new arrivals', () => {
    const later = new WaitingListEntry({
      customer_id: new CustomerId().value,
      position: 8,
      status: WaitingListEntryStatus.PENDING,
    });
    const earlier = new WaitingListEntry({
      customer_id: new CustomerId().value,
      position: 3,
      status: WaitingListEntryStatus.PENDING,
    });
    list.entries.add(later, earlier);

    list.notifyFirstPending(new EventSpotId());
    const added = list.join(new CustomerId());

    expect(earlier.status).toBe(WaitingListEntryStatus.NOTIFIED);
    expect(later.status).toBe(WaitingListEntryStatus.PENDING);
    expect(added.position).toBe(9);
    expect(list.toJSON().entries.map((entry) => entry.id)).toEqual([
      earlier.id.value,
      later.id.value,
      added.id.value,
    ]);
  });
});