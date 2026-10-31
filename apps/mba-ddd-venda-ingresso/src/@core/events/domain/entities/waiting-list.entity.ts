import { AggregateRoot } from '../../../common/domain/aggregate-root';
import {
  AnyCollection,
  ICollection,
  MyCollectionFactory,
} from '../../../common/domain/my-collection';
import Uuid from '../../../common/domain/value-objects/uuid.vo';
import { CustomerJoinedWaitingList } from '../events/domain-events/customer-joined-waiting-list.event';
import { SpotOfferedToWaitingCustomer } from '../events/domain-events/spot-offered-to-waiting-customer.event';
import { CustomerId } from './customer.entity';
import { EventSectionId } from './event-section';
import { EventSpotId } from './event-spot';
import { EventId } from './event.entity';
import {
  WaitingListEntry,
  WaitingListEntryStatus,
} from './waiting-list-entry.entity';

export class WaitingListId extends Uuid {}

export type WaitingListConstructorProps = {
  id?: WaitingListId | string;
  event_id: EventId | string;
  section_id: EventSectionId | string;
};

export class WaitingList extends AggregateRoot {
  id: WaitingListId;
  event_id: EventId;
  section_id: EventSectionId;
  private _entries: ICollection<WaitingListEntry>;

  constructor(props: WaitingListConstructorProps) {
    super();
    this.id =
      typeof props.id === 'string'
        ? new WaitingListId(props.id)
        : props.id ?? new WaitingListId();
    this.event_id =
      props.event_id instanceof EventId
        ? props.event_id
        : new EventId(props.event_id);
    this.section_id =
      props.section_id instanceof EventSectionId
        ? props.section_id
        : new EventSectionId(props.section_id);
    this._entries = MyCollectionFactory.create<WaitingListEntry>(this);
  }

  static create(command: { event_id: EventId; section_id: EventSectionId }) {
    return new WaitingList(command);
  }

  join(customer_id: CustomerId) {
    const pending = this.entries.find(
      (entry) =>
        entry.customer_id.equals(customer_id) &&
        entry.status === WaitingListEntryStatus.PENDING,
    );
    if (pending) {
      throw new Error('Customer already in waiting list');
    }

    const position =
      this.entries
        .values()
        .reduce((last, entry) => Math.max(last, entry.position), 0) + 1;
    const entry = WaitingListEntry.create({ customer_id, position });
    this.entries.add(entry);
    this.addEvent(
      new CustomerJoinedWaitingList(
        this.id,
        customer_id,
        this.event_id,
        this.section_id,
      ),
    );
    return entry;
  }

  notifyFirstPending(spot_id: EventSpotId) {
    const entry = this.entries
      .values()
      .filter((entry) => entry.status === WaitingListEntryStatus.PENDING)
      .sort((a, b) => a.position - b.position)[0];
    if (!entry) {
      return;
    }

    entry.markAsNotified();
    this.addEvent(
      new SpotOfferedToWaitingCustomer(
        this.id,
        entry.customer_id,
        this.event_id,
        this.section_id,
        spot_id,
      ),
    );
  }

  get entries(): ICollection<WaitingListEntry> {
    return this._entries;
  }

  set entries(entries: AnyCollection<WaitingListEntry>) {
    this._entries = MyCollectionFactory.createFrom<WaitingListEntry>(entries);
  }

  toJSON() {
    return {
      id: this.id.value,
      event_id: this.event_id.value,
      section_id: this.section_id.value,
      entries: [...this.entries.values()]
        .sort((a, b) => a.position - b.position)
        .map((entry) => entry.toJSON()),
    };
  }
}