// Shared request/response shapes for the catalog service.
export interface Row {
  id: number;
  name: string;
}

export interface ListBody {
  items: Row[];
  page: number;
  size: number;
  total: number;
}

export interface Query {
  page?: number;
  size?: number;
}

export interface Reply {
  status: number;
  body: ListBody | { error: string };
}
