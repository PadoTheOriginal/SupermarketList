"""Domain objects for the shopping list app.

These are plain data holders: everything that touches SQLite lives in
``database.py``.
"""
from dataclasses import dataclass, field


@dataclass
class User:
    UserId: int
    Username: str
    PasswordHash: str
    IsAdmin: bool = False
    CanShare: bool = False
    SessionEpoch: int = 0

    def ToDict(self):
        return {
            "id": self.UserId,
            "username": self.Username,
            "isAdmin": bool(self.IsAdmin),
            "canShare": bool(self.CanShare),
        }


@dataclass
class SupermarketItem:
    SupermarketItemId: int
    Name: str
    Quantity: float
    Price: float
    SupermarketListId: int
    Checked: bool = False
    Position: int = 0

    @property
    def Total(self):
        return self.Quantity * self.Price

    def ToDict(self):
        return {
            "id": self.SupermarketItemId,
            "listId": self.SupermarketListId,
            "name": self.Name,
            "quantity": self.Quantity,
            "price": self.Price,
            "checked": self.Checked,
            "position": self.Position,
            "total": round(self.Total, 2),
        }


@dataclass
class SupermarketList:
    SupermarketListId: int
    Name: str
    OwnerId: int
    Position: int = 0
    SupermarketItems: list = field(default_factory=list)
    # Populated for the acting user: who owns the list, and whether it reached
    # them through a share rather than being their own.
    OwnerName: str = None
    Shared: bool = False

    @property
    def Total(self):
        return sum(item.Total for item in self.SupermarketItems)

    @property
    def CheckedTotal(self):
        return sum(item.Total for item in self.SupermarketItems if item.Checked)

    def ToDict(self):
        return {
            "id": self.SupermarketListId,
            "name": self.Name,
            "position": self.Position,
            "items": [item.ToDict() for item in self.SupermarketItems],
            "total": round(self.Total, 2),
            "checkedTotal": round(self.CheckedTotal, 2),
            "ownerId": self.OwnerId,
            "owner": self.OwnerName,
            "shared": bool(self.Shared),
        }
