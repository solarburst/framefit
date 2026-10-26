import { StrictMode, useEffect, useState } from "react"
import { createRoot } from "react-dom/client"
import { Order, type OrderData } from "./Order"
import "./order.css"

function App() {
  const [order, setOrder] = useState<OrderData | null>(null)

  useEffect(() => {
    let cancelled = false
    fetch("/api/order")
      .then((response) => response.json())
      .then((data: OrderData) => {
        if (!cancelled) setOrder(data)
      })
    return () => {
      cancelled = true
    }
  }, [])

  if (!order) return null

  return <Order order={order} />
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
