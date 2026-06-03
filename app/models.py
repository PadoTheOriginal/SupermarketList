from database import DataBase

class User:
    def __init__(self, userId, username, passwordHash, supermarketList = True):
        self.UserId: int = userId
        self.Username: str = username
        self.PasswordHash: str = passwordHash
        self.Online: bool = False
        self.SupermarketLists = []
        if supermarketList:
            self.SupermarketLists:list(SupermarketList) = SupermarketList.GetSupermarketLists(userId)

    def __str__(self):
        return str((self.UserId, self.Username, self.PasswordHash, self.Online, self.SupermarketLists))

    @staticmethod
    def GetUsers():
        return DataBase().GetUsers()

    @staticmethod
    def GetUser(username, supermarketList):
        return DataBase().GetUser(username, supermarketList)
    
class SupermarketList:
    def __init__(self, supermarketListId, name, ownerId, order):
        self.SupermarketListId:int = supermarketListId
        self.Name:str = name
        self.OwnerId:int = ownerId
        self.Order:int = order
        self.SupermarketItems:list(SupermarketItem) = SupermarketItem.GetSupermarketItems(supermarketListId)
    
    def __str__(self):
        return str((self.SupermarketListId, self.Name, self.OwnerId, self.Order))

    @property
    def Total(self):
        return sum([item.Total for item in self.SupermarketItems])
    
    @property
    def TotalFormatted(self):
        return 'R${:,.2f}'.format(self.Total)
        
    @staticmethod
    def GetSupermarketLists(ownerId):
        return DataBase().GetSupermarketLists(ownerId)
        
    @staticmethod
    def GetSupermarketListTotalFormatted(supermarketListId):
        return 'R${:,.2f}'.format(DataBase().GetSupermarketListTotal(supermarketListId))
    
class SupermarketItem:
    def __init__(self, supermarketItemId, name, quantity, price, supermarketListId):
        self.SupermarketItemId:int = supermarketItemId
        self.Name:str = name
        self.Quantity:int = quantity
        self.Price:float = price
        self.SupermarketListId:int = supermarketListId


    def ToDict(self):
        return {'SupermarketItemId': self.SupermarketItemId,
                'Name': self.Name,
                'Quantity': self.Quantity,
                'Price': self.Price,
                'SupermarketListId': self.SupermarketListId,
                'Total': self.Total,
                'TotalFormatted': self.TotalFormatted
                }

    @property
    def Total(self):
        return self.Price * self.Quantity 
    
    @property
    def TotalFormatted(self):
        return 'R${:,.2f}'.format(self.Total)
    
    @staticmethod
    def GetSupermarketItems(supermarketListId):
        return DataBase().GetSupermarketItems(supermarketListId)
    
    def InsertSupermarketItem(self):
        return DataBase().InsertSupermarketItem(self)
    
    def UpdateSupermarketItem(self):
        return DataBase().UpdateSupermarketItem(self)
    
    @staticmethod
    def DeleteSupermarketItem(supermarketItemId):
        return DataBase().DeleteSupermarketItem(supermarketItemId)
    