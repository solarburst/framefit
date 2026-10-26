export type OrderItem = {
  name: string
  qty: string
  price: string
}

export type OrderData = {
  when: string
  time: string
  day: string
  place: string
  number: string
  items: OrderItem[]
  total: string
  status: string
  address: string
  hint: string
}

export function Order({ order }: { order: OrderData }) {
  return (
    <article className="card">
      <header className="when">
        <p className="badge">{order.when}</p>
        <p className="time">{order.time}</p>
        <p className="day">{order.day}</p>
      </header>
      <div className="body">
        <h1 className="place">{order.place}</h1>
        <p className="number">{order.number}</p>
        <ul className="items">
          {order.items.map((item) => (
            <li className="item" key={item.name}>
              <p className="item-name">{item.name}</p>
              <p className="item-qty">{item.qty}</p>
              <p className="item-price">{item.price}</p>
            </li>
          ))}
        </ul>
        <div className="total">
          <p className="total-label">Итого</p>
          <p className="total-price">{order.total}</p>
        </div>
        <p className="status">{order.status}</p>
        <p className="approach">Куда подойти</p>
        <p className="address" data-framefit-truncate>
          {order.address}
        </p>
        <p className="hint">{order.hint}</p>
        <button className="here" type="button">
          Я на месте
        </button>
      </div>
    </article>
  )
}
