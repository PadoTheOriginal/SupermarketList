import os, shutil
import sqlite3
import models

class DataBase:
    conn = None

    def __init__(self):
        if not os.path.exists('./app/sqlite.db'):
            # Creates the database file from the defaults, in case it doesn't exist.
            shutil.copy('./app/sqlite_default.db', './app/sqlite.db')

        self.conn = sqlite3.connect('./app/sqlite.db', timeout=10)

    def GetUsers(self): 
        cur = self.conn.cursor()
        cur.execute("Select * From Users")
        
        users = list(map(lambda a: models.User(*a), cur.fetchall()))
        
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return users

    def GetUser(self, username, supermarketList = False): 
        cur = self.conn.cursor()

        cur.execute("Select * From Users where Username = ?", (username, ))
        
        user = models.User(*cur.fetchone(), supermarketList = supermarketList)
        
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return user

    def GetSupermarketListTotal(self, supermarketListId): 
        cur = self.conn.cursor()
        
        cur.execute("Select IfNull(Sum(Quantity * Price), 0) From SupermarketItems where SupermarketListId = ?", (supermarketListId, ))
                
        total = cur.fetchone()[0]
        
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return total

    def GetSupermarketLists(self, ownerId): 
        cur = self.conn.cursor()
        
        cur.execute("Select * from SupermarketLists Where OwnerId = ? Order by [SupermarketListId] asc",
                    (ownerId, ))
                
        supermarketlists = list(map(lambda a: models.SupermarketList(*a), cur.fetchall()))
        
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return supermarketlists

    def GetSupermarketItems(self, supermarketListId): 
        cur = self.conn.cursor()
        
        cur.execute("Select * from SupermarketItems Where SupermarketListId = ?", (supermarketListId, ))
        
        supermarketlists = list(map(lambda a: models.SupermarketItem(*a), cur.fetchall()))
        
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return supermarketlists

    def InsertSupermarketItem(self, supermarketItem): 
        cur = self.conn.cursor()
        
        cur.execute("Insert Into SupermarketItems(Name,Quantity,Price,SupermarketListId) Values(?,?,?,?)",
                    (supermarketItem.Name, supermarketItem.Quantity, supermarketItem.Price, supermarketItem.SupermarketListId))
        
        supermarketItem.SupermarketItemId = cur.lastrowid
        
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return supermarketItem

    def UpdateSupermarketItem(self, supermarketItem): 
        cur = self.conn.cursor()
        
        cur.execute("Update SupermarketItems Set Name = ?, Quantity = ?, Price = ? Where SupermarketItemId = ?",
                    (supermarketItem.Name, supermarketItem.Quantity, supermarketItem.Price, supermarketItem.SupermarketItemId))
                
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return supermarketItem

    def DeleteSupermarketItem(self, supermarketItemId): 
        cur = self.conn.cursor()
        
        cur.execute("Delete from SupermarketItems Where SupermarketItemId = ?", (supermarketItemId, ))
                
        cur.close()
        self.conn.commit()
        self.conn.close()
        
        return True

if __name__ == '__main__':
    # DataBase()
    # print(DataBase().GetUser('admin@admin', True))
    
    
    for i in DataBase().GetSupermarketLists(1):
        print(i)
        

    
